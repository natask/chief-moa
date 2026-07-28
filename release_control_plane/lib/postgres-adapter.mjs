"use strict";

// The caller owns pool construction, credentials, TLS, and lifecycle. This
// adapter performs only tenant/application-scoped reads and append-only writes.
export function createPostgresReleaseAdapter(pool) {
  if (!pool || typeof pool.query !== "function" || typeof pool.connect !== "function") {
    throw new Error("postgres pool with query() and connect() is required");
  }

  const list = async (table, tenantId, applicationId) => {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await setTenant(client, tenantId);
      const result = await client.query(
        `select record from ${table} where tenant_id = $1 and application_id = $2 order by created_at, event_order`,
        [tenantId, applicationId],
      );
      await client.query("commit");
      return result.rows.map((row) => row.record);
    } catch (error) {
      try { await client.query("rollback"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  };

  async function appendAssignmentEvent(event, expectedSequence) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await setTenant(client, event.tenant_id);
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${event.tenant_id}:${event.application_id}:${event.scope_type}:${event.scope_id}`],
      );
      if (event.idempotency_key) {
        const prior = await client.query(
          `select record from release_assignment_events
            where tenant_id = $1 and application_id = $2 and scope_type = $3
              and scope_id = $4 and idempotency_key = $5`,
          [
            event.tenant_id, event.application_id, event.scope_type,
            event.scope_id, event.idempotency_key,
          ],
        );
        if (prior.rowCount === 1) {
          const record = prior.rows[0].record;
          if (record.channel !== event.channel || record.bundle_id !== event.bundle_id
              || record.operation !== event.operation) {
            throw idempotencyConflict();
          }
          await client.query("commit");
          return record;
        }
      }
      const current = await client.query(
        `select coalesce(max(sequence), 0)::bigint as sequence
           from release_assignment_events
          where tenant_id = $1 and application_id = $2 and scope_type = $3 and scope_id = $4`,
        [event.tenant_id, event.application_id, event.scope_type, event.scope_id],
      );
      const actual = Number(current.rows[0].sequence);
      if (actual !== expectedSequence) throw sequenceConflict(expectedSequence, actual);
      await client.query(
        `insert into release_assignment_events
          (event_id, tenant_id, application_id, scope_type, scope_id, sequence, idempotency_key, created_at, record)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          event.event_id, event.tenant_id, event.application_id, event.scope_type,
          event.scope_id, event.sequence, event.idempotency_key, event.created_at, JSON.stringify(event),
        ],
      );
      await client.query("commit");
      return structuredClone(event);
    } catch (error) {
      try { await client.query("rollback"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function appendRecord(table, idColumn, record, id) {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await setTenant(client, record.tenant_id);
      const result = await client.query(
        `insert into ${table}
        (${idColumn}, tenant_id, application_id, device_id, idempotency_key, created_at, record)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb)
       on conflict (tenant_id, application_id, ${idColumn}) do nothing
       returning record`,
        [
          id, record.tenant_id, record.application_id, record.device_id,
          record.idempotency_key, record.created_at, JSON.stringify(record),
        ],
      );
      if (result.rowCount === 1) {
        await client.query("commit");
        return result.rows[0].record;
      }
      const existing = await client.query(
        `select record, record = $4::jsonb as same from ${table}
        where ${idColumn} = $1 and tenant_id = $2 and application_id = $3`,
        [id, record.tenant_id, record.application_id, JSON.stringify(record)],
      );
      if (existing.rowCount !== 1 || existing.rows[0].same !== true) {
        throw new Error(`${idColumn} is immutable`);
      }
      await client.query("commit");
      return existing.rows[0].record;
    } catch (error) {
      try { await client.query("rollback"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function publishBundleAndChannelHead({
    bundle,
    head,
    receipt,
    expected_head_sequence: expectedSequence,
  }) {
    validatePublicationCoordinates(bundle, head, receipt);
    const client = await pool.connect();
    try {
      await client.query("begin");
      await setTenant(client, bundle.tenant_id);
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${bundle.tenant_id}:${bundle.application_id}:${head.channel}`],
      );
      const priorReceipt = await client.query(
        `select record from release_publication_receipts
          where tenant_id = $1 and application_id = $2 and receipt_id = $3`,
        [bundle.tenant_id, bundle.application_id, receipt.receipt_id],
      );
      if (priorReceipt.rowCount === 1) {
        const priorBundle = await client.query(
          `select record from release_bundles
            where tenant_id = $1 and application_id = $2 and bundle_id = $3`,
          [bundle.tenant_id, bundle.application_id, bundle.bundle_id],
        );
        const priorHead = await client.query(
          `select record from release_channel_head_events
            where tenant_id = $1 and application_id = $2 and channel = $3 and sequence = $4`,
          [bundle.tenant_id, bundle.application_id, head.channel, head.sequence],
        );
        if (priorBundle.rowCount !== 1 || priorHead.rowCount !== 1
            || !sameJson(priorReceipt.rows[0].record, receipt)
            || !sameJson(priorBundle.rows[0].record, bundle)
            || !sameJson(priorHead.rows[0].record, head)) {
          throw immutableConflict("publication receipt");
        }
        await client.query("commit");
        return {
          bundle: priorBundle.rows[0].record,
          head: priorHead.rows[0].record,
          receipt: priorReceipt.rows[0].record,
        };
      }
      const currentResult = await client.query(
        `select coalesce(max(sequence), 0)::bigint as sequence
          from release_channel_head_events
          where tenant_id = $1 and application_id = $2 and channel = $3`,
        [bundle.tenant_id, bundle.application_id, head.channel],
      );
      const current = Number(currentResult.rows[0].sequence);
      if (current !== expectedSequence || head.sequence !== current + 1) {
        throw channelSequenceConflict(expectedSequence, current);
      }
      const bundleInsert = await client.query(
        `insert into release_bundles
          (bundle_id, tenant_id, application_id, created_at, record)
         values ($1, $2, $3, $4, $5::jsonb)
         on conflict (tenant_id, application_id, bundle_id) do nothing
         returning record`,
        [
          bundle.bundle_id, bundle.tenant_id, bundle.application_id,
          bundle.created_at, JSON.stringify(bundle),
        ],
      );
      if (bundleInsert.rowCount === 0) {
        const existing = await client.query(
          `select record from release_bundles
            where tenant_id = $1 and application_id = $2 and bundle_id = $3`,
          [bundle.tenant_id, bundle.application_id, bundle.bundle_id],
        );
        if (existing.rowCount !== 1 || !sameJson(existing.rows[0].record, bundle)) {
          throw immutableConflict("bundle_id");
        }
      }
      await client.query(
        `insert into release_channel_head_events
          (tenant_id, application_id, channel, sequence, created_at, record)
         values ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          head.tenant_id, head.application_id, head.channel, head.sequence,
          head.updated_at, JSON.stringify(head),
        ],
      );
      await client.query(
        `insert into release_publication_receipts
          (receipt_id, tenant_id, application_id, channel, sequence, created_at, record)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          receipt.receipt_id, receipt.tenant_id, receipt.application_id,
          receipt.channel, receipt.new_sequence, receipt.created_at,
          JSON.stringify(receipt),
        ],
      );
      await client.query("commit");
      return {
        bundle: structuredClone(bundle),
        head: structuredClone(head),
        receipt: structuredClone(receipt),
      };
    } catch (error) {
      try { await client.query("rollback"); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  return Object.freeze({
    listBundles: (tenantId, applicationId) => list("release_bundles", tenantId, applicationId),
    async listPublishedBundles(tenantId, applicationId) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await setTenant(client, tenantId);
        const result = await client.query(
          `select b.record
             from release_bundles b
            where b.tenant_id = $1 and b.application_id = $2
              and exists (
                select 1 from release_publication_receipts p
                 where p.tenant_id = b.tenant_id
                   and p.application_id = b.application_id
                   and p.record->>'bundle_id' = b.bundle_id
              )
            order by b.created_at desc, b.bundle_id desc`,
          [tenantId, applicationId],
        );
        await client.query("commit");
        return result.rows.map((row) => row.record);
      } catch (error) {
        try { await client.query("rollback"); } catch {}
        throw error;
      } finally {
        client.release();
      }
    },
    listChannelHeads: (tenantId, applicationId) => list("release_channel_head_events", tenantId, applicationId),
    listAssignmentEvents: (tenantId, applicationId) => list("release_assignment_events", tenantId, applicationId),
    appendAssignmentEvent,
    listInstallReceipts: (tenantId, applicationId) => list("release_install_receipts", tenantId, applicationId),
    appendInstallReceipt: (record) => appendRecord("release_install_receipts", "receipt_id", record, record.receipt_id),
    listFeedback: (tenantId, applicationId) => list("release_feedback", tenantId, applicationId),
    appendFeedback: (record) => appendRecord("release_feedback", "feedback_id", record, record.feedback_id),
    publishBundleAndChannelHead,
    listPublicationReceipts: (tenantId, applicationId) => list(
      "release_publication_receipts",
      tenantId,
      applicationId,
    ),
  });
}

function setTenant(client, tenantId) {
  return client.query("select set_config('moa.tenant_id', $1, true)", [tenantId]);
}

function sequenceConflict(expected, actual) {
  const error = new Error(`assignment sequence conflict: expected ${expected}, actual ${actual}`);
  error.code = "assignment_sequence_conflict";
  error.expected_sequence = expected;
  error.actual_sequence = actual;
  return error;
}

function idempotencyConflict() {
  const error = new Error("idempotency_key was reused for a different assignment");
  error.code = "release_binding_mismatch";
  error.reason = "idempotency_key_reused";
  return error;
}

function channelSequenceConflict(expected, actual) {
  const error = new Error(`channel head sequence conflict: expected ${expected}, actual ${actual}`);
  error.code = "channel_head_sequence_conflict";
  error.expected_sequence = expected;
  error.actual_sequence = actual;
  return error;
}

function immutableConflict(field) {
  const error = new Error(`${field} is immutable`);
  error.code = "release_publication_immutable_conflict";
  return error;
}

function sameJson(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validatePublicationCoordinates(bundle, head, receipt) {
  if (!["stable", "preview"].includes(head.channel)) throw new Error("channel is invalid");
  for (const record of [head, receipt]) {
    if (record.tenant_id !== bundle.tenant_id
        || record.application_id !== bundle.application_id
        || record.bundle_id !== bundle.bundle_id) {
      throw new Error("publication coordinates do not match");
    }
  }
  if (receipt.channel !== head.channel || receipt.new_sequence !== head.sequence) {
    throw new Error("publication coordinates do not match");
  }
}
