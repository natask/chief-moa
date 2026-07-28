begin;

-- Bundles are already immutable catalog records. These additive indexes make
-- publication order and lineage traversal bounded without copying mutable heads.
create index if not exists release_bundles_catalog_page
  on release_bundles (tenant_id, application_id, created_at desc, bundle_id desc);
create index if not exists release_bundles_series_parent
  on release_bundles (tenant_id, application_id, (record->'lineage'->>'series_parent_bundle_id'))
  where record->'lineage'->>'series_parent_bundle_id' is not null;
create index if not exists release_publication_receipts_bundle
  on release_publication_receipts (tenant_id, application_id, (record->>'bundle_id'))
  where record ? 'bundle_id';

commit;
