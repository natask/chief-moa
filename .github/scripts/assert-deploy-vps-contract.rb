#!/usr/bin/env ruby
# frozen_string_literal: true

require "fileutils"
require "json"
require "open3"
require "tmpdir"
require "yaml"

ROOT = File.expand_path("../..", __dir__)
WORKFLOW_PATH = File.join(ROOT, ".github/workflows/deploy-vps.yml")
CHECKOUT_ACTION = "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5".freeze
SETUP_NODE_ACTION = "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020".freeze
DEPLOY_PATHS = [
  ".github/scripts/assert-deploy-vps-contract.rb",
  ".github/workflows/deploy-vps.yml",
  "gateway/**",
  "docker-compose.yml",
  "docker-compose.vps.yml",
  "scripts/vps/**"
].freeze
VERIFICATION_ENV = {
  "BASH_ENV" => "/dev/null",
  "ENV" => "/dev/null",
  "GIT_CONFIG_GLOBAL" => "/dev/null",
  "GIT_CONFIG_NOSYSTEM" => "1",
  "GIT_CONFIG_COUNT" => "0",
  "NODE_OPTIONS" => "",
  "NODE_PATH" => "",
  "RUBYOPT" => "",
  "RUBYLIB" => ""
}.freeze
PUBLISH_ENV = {
  "BASH_ENV" => "/dev/null",
  "ENV" => "/dev/null",
  "GIT_CONFIG_GLOBAL" => "/dev/null",
  "GIT_CONFIG_NOSYSTEM" => "1",
  "GIT_CONFIG_COUNT" => "0"
}.freeze
OBSERVE_ENV = VERIFICATION_ENV.merge(
  "EXPECTED_GIT_SHA" => "${{ github.sha }}",
  "HEALTH_URL" => "https://api.agee.app/health",
  # Read-only token for the compare call that separates an intermediate
  # promotion from a real regression. The job declares contents: read.
  "GITHUB_TOKEN" => "${{ github.token }}"
).freeze
VERIFY_SCRIPT = <<~'BASH'
  set -euo pipefail
  bash -n scripts/vps/*.sh
  bash scripts/vps/test-node-runtime.sh
  bash scripts/vps/test-preview-tls-proxy.sh
  bash scripts/vps/test-install-promotion-control-plane.sh
  bash scripts/vps/test-install-release-control-database-credentials.sh
  bash scripts/vps/test-update-rollback.sh
  cd gateway
  # Same installer and lockfile as dev and the Docker image: what gets
  # verified is what ships.
  corepack enable
  corepack prepare --activate
  pnpm install --frozen-lockfile
  pnpm run check
BASH
PUBLISH_SCRIPT = <<~'BASH'
  set -euo pipefail
  git fetch --no-tags origin refs/heads/master:refs/remotes/origin/master
  test "$(git rev-parse refs/remotes/origin/master)" = "$GITHUB_SHA"
  git push --atomic origin "${GITHUB_SHA}:refs/heads/vps-deploy"
BASH
OBSERVE_SCRIPT = <<~'BASH'
  set -euo pipefail
  # 2400s (40 min): observed worst case is ~24 minutes end to end
  # (run 30328408716, 2026-07-28) and typical successful runs already
  # ran ~19-20 minutes against the old 1200s deadline, i.e. almost no
  # headroom. 40 minutes gives ~67% headroom over the worst observed
  # case and ~2x over the typical case.
  deadline_seconds=2400
  deadline="$(( $(date +%s) + deadline_seconds ))"
  live_sha="unavailable"
  starting_sha=""
  had_response=0
  saw_connection_drop=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    health="$(curl -fsS --connect-timeout 5 --max-time 10 \
      -H 'Cache-Control: no-cache' "$HEALTH_URL" || true)"
    observed="$(ruby -rjson -e '
      health = JSON.parse(STDIN.read)
      sha = health.dig("build", "git_sha")
      abort unless sha.is_a?(String) && sha.match?(/\A[0-9a-f]{7,64}\z/i)
      print sha.downcase
    ' <<<"$health" 2>/dev/null || true)"
    if [ -n "$observed" ]; then
      [ -n "$starting_sha" ] || starting_sha="$observed"
      had_response=1
      live_sha="$observed"
    elif [ "$had_response" -eq 1 ]; then
      # A response we previously got now fails to connect/parse. The
      # promotion script recreates the gateway container in place
      # (compose up -d --no-deps gateway), which causes exactly this
      # kind of transient drop -- a real, externally observable sign
      # the droplet is actively promoting, not a guess.
      saw_connection_drop=1
    fi

    if [ "$live_sha" = "$EXPECTED_GIT_SHA" ]; then
      echo "active gateway serves exact commit $EXPECTED_GIT_SHA"
      exit 0
    fi

    if [ -n "$starting_sha" ] && [ "$live_sha" != "unavailable" ] \
      && [ "$live_sha" != "$EXPECTED_GIT_SHA" ] && [ "$live_sha" != "$starting_sha" ]; then
      # A THIRD commit: neither the pre-deploy build nor the expected
      # one. That is NOT automatically a regression. When master moves
      # several times in quick succession the droplet promotes each
      # vps-deploy ref move in sequence, so the gateway legitimately
      # passes through intermediate commits on its way to ours. Run
      # 30350237688 (2026-07-28) failed exactly this way: expected
      # 91ffd7f4, observed 944cebe1, which is an ancestor of it.
      #
      # Ask GitHub whether the observed commit is behind ours. compare
      # base...head reports "ahead" when head is ahead of base, so
      # base=observed head=expected returning ahead/identical means the
      # observed commit is on the path to ours -- keep waiting.
      cmp_status="$(curl -fsS --connect-timeout 5 --max-time 10 \
        -H "Authorization: Bearer $GITHUB_TOKEN" \
        -H "Accept: application/vnd.github+json" \
        "$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/compare/$live_sha...$EXPECTED_GIT_SHA" 2>/dev/null \
        | ruby -rjson -e 'print(JSON.parse(STDIN.read)["status"].to_s)' 2>/dev/null || true)"
      case "$cmp_status" in
        ahead|identical)
          echo "active gateway serves $live_sha, an ancestor of $EXPECTED_GIT_SHA (intermediate promotion in progress); continuing to wait"
          ;;
        behind|diverged)
          echo "::error::active gateway now serves $live_sha, which is $cmp_status relative to the expected commit $EXPECTED_GIT_SHA and is not the pre-deploy commit ($starting_sha) -- this is a real regression, not a slow promotion" >&2
          exit 1
          ;;
        *)
          # Could not classify it. Do not claim a regression on a
          # failed API call; keep waiting and let the timeout report
          # honestly rather than assert something unproven.
          echo "could not classify observed commit $live_sha against $EXPECTED_GIT_SHA (compare status: '${cmp_status:-unavailable}'); continuing to wait"
          ;;
      esac
    fi

    echo "waiting for active gateway: expected=$EXPECTED_GIT_SHA observed=$live_sha"
    sleep 15
  done

  # The window elapsed without reaching the expected commit. This is
  # NOT the same as a confirmed failure: /health does not expose any
  # in-progress/update-status signal, so a slow-but-succeeding
  # promotion and a stuck one look identical from here except for
  # connection drops during container recreation. Report distinctly
  # from a hard failure and say how to check manually; the run still
  # exits non-zero because the gate must not pass without evidence.
  if [ "$saw_connection_drop" -eq 1 ]; then
    echo "::warning::verification window elapsed without reaching $EXPECTED_GIT_SHA, but health checks intermittently failed to connect during the wait -- consistent with the gateway container being actively recreated by the promotion script. INCONCLUSIVE, not a confirmed failure: the deploy may still be finishing. Re-check manually: curl -s $HEALTH_URL | ruby -rjson -e 'puts JSON.parse(STDIN.read).dig(\"build\",\"git_sha\")'" >&2
  else
    echo "::warning::verification window elapsed without reaching $EXPECTED_GIT_SHA and no connection activity was observed. INCONCLUSIVE, not a confirmed failure: this can mean the droplet's auto-update timer has not picked up the candidate yet, or an earlier attempt failed and update.sh's built-in rollback safely restored the previous commit ($starting_sha). No in-progress signal is exposed over HTTP, so this script cannot tell 'still working' from 'stuck and already rolled back' without droplet access. Re-check manually: curl -s $HEALTH_URL | ruby -rjson -e 'puts JSON.parse(STDIN.read).dig(\"build\",\"git_sha\")', or ssh into the droplet and check journalctl -u chief-moa-auto-update / docker compose logs gateway." >&2
  fi
  echo "active gateway stayed at $live_sha, expected $EXPECTED_GIT_SHA (timeout after $(( deadline_seconds / 60 ))m)" >&2
  exit 1
BASH

class ContractError < StandardError; end

def fail_contract(message)
  raise ContractError, message
end

def assert_contract(condition, message)
  fail_contract(message) unless condition
end

def command!(*command, chdir:, env: {})
  stdout, stderr, status = Open3.capture3(env, *command, chdir: chdir)
  return stdout if status.success?

  fail_contract("#{command.join(' ')} failed:\n#{stdout}#{stderr}")
end

def command_fails?(*command, chdir:, env: {})
  _stdout, _stderr, status = Open3.capture3(env, *command, chdir: chdir)
  !status.success?
end

def deep_copy(value)
  Marshal.load(Marshal.dump(value))
end

def expect_rejected!(label)
  rejected = false
  begin
    yield
  rescue ContractError
    rejected = true
  end
  assert_contract(rejected, "#{label} mutation was accepted")
end

def validate_workflow!(workflow)
  root_keys = workflow.keys.map { |key| key == true ? "on" : key.to_s }.sort
  expected_root_keys = %w[concurrency jobs name on permissions].sort
  assert_contract(root_keys == expected_root_keys,
                  "workflow contains an unexpected inherited authority surface")

  triggers = workflow["on"] || workflow[true] # Psych uses YAML 1.1 booleans.
  jobs = workflow.fetch("jobs")
  assert_contract(jobs.keys.sort == %w[deploy observe publish],
                  "workflow must contain only verification, publication, and live observation jobs")
  verify_job = jobs.fetch("deploy")
  publish_job = jobs.fetch("publish")
  observe_job = jobs.fetch("observe")

  expected_triggers = {
    "push" => { "branches" => ["master"], "paths" => DEPLOY_PATHS },
    "pull_request" => { "paths" => DEPLOY_PATHS },
    "workflow_dispatch" => {}
  }
  assert_contract(triggers == expected_triggers,
                  "workflow triggers must match the canonical verification set")
  assert_contract(workflow.fetch("name") == "Deploy VPS gateway",
                  "workflow name changed unexpectedly")
  assert_contract(workflow.fetch("concurrency") == {
                    "group" => "chief-moa-vps-deploy",
                    "cancel-in-progress" => false
                  }, "workflow concurrency changed unexpectedly")
  assert_contract(workflow.fetch("permissions") == { "contents" => "read" },
                  "workflow default contents permission must remain read-only")

  expected_verify_job = {
    "name" => "Verify gateway",
    "runs-on" => "ubuntu-latest",
    "timeout-minutes" => 30,
    "permissions" => { "contents" => "read" },
    "steps" => [
      {
        "name" => "Check out repository",
        "uses" => CHECKOUT_ACTION
      },
      {
        "name" => "Set up Node",
        "uses" => SETUP_NODE_ACTION,
        "with" => { "node-version" => 22 }
      },
      {
        "name" => "Assert deployment workflow contract",
        "shell" => "bash",
        "env" => VERIFICATION_ENV,
        "run" => "ruby .github/scripts/assert-deploy-vps-contract.rb"
      },
      {
        "name" => "Verify gateway",
        "shell" => "bash",
        "env" => VERIFICATION_ENV,
        "run" => VERIFY_SCRIPT
      }
    ]
  }
  assert_contract(verify_job == expected_verify_job,
                  "verification job must match the canonical closed shape")
  assert_contract(publish_job.fetch("needs") == "deploy",
                  "publication must depend on successful gateway verification")
  assert_contract(publish_job.fetch("permissions") == { "contents" => "write" },
                  "publication job must explicitly receive contents: write")

  write_jobs = jobs.each_with_object([]) do |(name, job), names|
    names << name if job.fetch("permissions", {}).fetch("contents", nil) == "write"
  end
  assert_contract(write_jobs == ["publish"],
                  "only the publication job may receive contents: write")

  gate = publish_job.fetch("if").gsub(/\s+/, "")
  expected_gate = "${{success()&&github.event_name=='push'&&github.ref=='refs/heads/master'}}"
  assert_contract(gate == expected_gate,
                  "publication must be gated by success and an exact master push")

  expected_job_keys = %w[if name needs permissions runs-on steps timeout-minutes]
  assert_contract(publish_job.keys.sort == expected_job_keys.sort,
                  "publication job contains an unexpected authority surface")
  expected_steps = [
    {
      "name" => "Check out verified commit",
      "uses" => CHECKOUT_ACTION,
      "with" => { "ref" => "${{ github.sha }}", "fetch-depth" => 0 }
    },
    {
      "name" => "Publish vps-deploy ref",
      "shell" => "bash",
      "env" => PUBLISH_ENV,
      "run" => PUBLISH_SCRIPT
    }
  ]
  assert_contract(publish_job.fetch("steps") == expected_steps,
                  "publication job must contain only checkout and the canonical ref update")

  assert_contract(observe_job == {
                    "name" => "Verify live gateway commit",
                    "needs" => "publish",
                    "if" => "${{ success() && github.event_name == 'push' && github.ref == 'refs/heads/master' }}",
                    "runs-on" => "ubuntu-latest",
                    "timeout-minutes" => 45,
                    "permissions" => { "contents" => "read" },
                    "steps" => [
                      {
                        "name" => "Wait for exact commit at active gateway",
                        "shell" => "bash",
                        "env" => OBSERVE_ENV,
                        "run" => OBSERVE_SCRIPT
                      }
                    ]
                  }, "live observation must be read-only and bind active health to the exact commit")

  PUBLISH_SCRIPT
end

def assert_negative_mutations!(workflow)
  rogue_push = deep_copy(workflow)
  rogue_script = rogue_push.fetch("jobs").fetch("publish").fetch("steps")[1]
  rogue_script["run"] = PUBLISH_SCRIPT.sub(
    "git push --atomic origin",
    "git push --force origin HEAD:refs/heads/rogue\ngit push --atomic origin"
  )
  expect_rejected!("rogue ref push") { validate_workflow!(rogue_push) }

  extra_step = deep_copy(workflow)
  extra_step.fetch("jobs").fetch("publish").fetch("steps") << {
    "name" => "Publish rogue ref",
    "shell" => "bash",
    "run" => "git update-ref refs/heads/rogue HEAD\n"
  }
  expect_rejected!("extra publication step") { validate_workflow!(extra_step) }

  inherited_bash = deep_copy(workflow)
  inherited_bash["env"] = { "BASH_ENV" => "/tmp/publish-rogue-ref" }
  expect_rejected!("workflow-level BASH_ENV hook") do
    validate_workflow!(inherited_bash)
  end

  id_token = deep_copy(workflow)
  id_token.fetch("jobs").fetch("deploy").fetch("permissions")["id-token"] = "write"
  expect_rejected!("verification id-token write") { validate_workflow!(id_token) }

  deploy_bash = deep_copy(workflow)
  deploy_bash.fetch("jobs").fetch("deploy")["env"] = {
    "BASH_ENV" => "/tmp/bypass-verification"
  }
  expect_rejected!("verification BASH_ENV hook") { validate_workflow!(deploy_bash) }

  custom_shell = deep_copy(workflow)
  contract_step = custom_shell.fetch("jobs").fetch("deploy").fetch("steps")[2]
  contract_step["shell"] = "bash -c 'true' -- {0}"
  expect_rejected!("verification custom shell") { validate_workflow!(custom_shell) }

  loose_observation = deep_copy(workflow)
  observation_script = loose_observation.fetch("jobs").fetch("observe").fetch("steps")[0]
  observation_script["run"] = OBSERVE_SCRIPT.sub(
    'if [ "$live_sha" = "$EXPECTED_GIT_SHA" ]; then',
    'if [ "$live_sha" != "unavailable" ]; then'
  )
  expect_rejected!("non-exact live observation") { validate_workflow!(loose_observation) }

  privileged_observation = deep_copy(workflow)
  privileged_observation.fetch("jobs").fetch("observe").fetch("permissions")["contents"] = "write"
  expect_rejected!("live observation write authority") { validate_workflow!(privileged_observation) }
end

def assert_verification_environment!(verification_env)
  Dir.mktmpdir("deploy-vps-verify-env-") do |tmp|
    marker = File.join(tmp, "bypass-ran")
    hook = File.join(tmp, "bash-env-hook")
    File.write(hook, "printf bypassed > \"$BYPASS_MARKER\"\n")
    process_env = { "BASH_ENV" => hook, "BYPASS_MARKER" => marker }.merge(verification_env)
    command!("bash", "-c", "true", chdir: tmp, env: process_env)
    assert_contract(!File.exist?(marker),
                    "verification environment executed inherited BASH_ENV")
  end
end

def assert_publish_behavior!(publish_script, publish_env)
  Dir.mktmpdir("deploy-vps-contract-") do |tmp|
    remote = File.join(tmp, "remote.git")
    source = File.join(tmp, "source")
    FileUtils.mkdir_p(source)
    command!("git", "init", "--bare", remote, chdir: tmp)
    command!("git", "init", "-b", "master", chdir: source)
    command!("git", "config", "user.name", "Deploy Contract", chdir: source)
    command!("git", "config", "user.email", "deploy-contract@example.invalid", chdir: source)

    File.write(File.join(source, "candidate.txt"), "verified\n")
    command!("git", "add", "candidate.txt", chdir: source)
    command!("git", "commit", "-m", "test: verified candidate", chdir: source)
    verified_sha = command!("git", "rev-parse", "HEAD", chdir: source).strip
    command!("git", "remote", "add", "origin", remote, chdir: source)
    command!("git", "push", "origin", "master", chdir: source)

    # HEAD differs, but remote master still identifies the verified candidate.
    File.write(File.join(source, "candidate.txt"), "newer checkout\n")
    command!("git", "commit", "-am", "test: newer checkout", chdir: source)
    newer_sha = command!("git", "rev-parse", "HEAD", chdir: source).strip
    assert_contract(newer_sha != verified_sha, "test setup did not create distinct SHAs")

    # Reproduce an inherited BASH_ENV attack. Step-level sanitization must
    # replace it before bash starts, so the hook cannot create the rogue ref.
    bash_hook = File.join(tmp, "bash-env-hook")
    File.write(bash_hook, "git push --force origin HEAD:refs/heads/rogue\n")
    process_env = { "BASH_ENV" => bash_hook }.merge(publish_env)
    process_env["GITHUB_SHA"] = verified_sha
    command!("bash", "-c", publish_script, chdir: source,
             env: process_env)
    rogue_absent = command_fails?("git", "--git-dir", remote, "show-ref",
                                  "--verify", "--quiet", "refs/heads/rogue",
                                  chdir: tmp)
    assert_contract(rogue_absent, "sanitized BASH_ENV still created a rogue ref")
    published_sha = command!("git", "--git-dir", remote, "rev-parse",
                             "refs/heads/vps-deploy", chdir: tmp).strip
    assert_contract(published_sha == verified_sha,
                    "publication did not advance vps-deploy to exact GITHUB_SHA")

    # Once master and vps-deploy advance, the older run must fail closed and
    # leave the newer deployment candidate in place.
    command!("git", "push", "origin", "master", chdir: source)
    command!("git", "push", "origin", "master:refs/heads/vps-deploy", chdir: source)
    stale_env = publish_env.merge("GITHUB_SHA" => verified_sha)
    stale_failed = command_fails?("bash", "-c", publish_script, chdir: source,
                                  env: stale_env)
    assert_contract(stale_failed, "stale candidate unexpectedly published")
    retained_sha = command!("git", "--git-dir", remote, "rev-parse",
                            "refs/heads/vps-deploy", chdir: tmp).strip
    assert_contract(retained_sha == newer_sha,
                    "stale candidate moved vps-deploy backward")
  end
end

def assert_observe_behavior!(observe_script, observe_env)
  Dir.mktmpdir("deploy-vps-observe-") do |tmp|
    expected_sha = "0123456789abcdef0123456789abcdef01234567"
    other_sha = "89abcdef0123456789abcdef0123456789abcdef"
    fake_curl = File.join(tmp, "curl")
    File.write(fake_curl, <<~'BASH')
      #!/usr/bin/env bash
      printf '%s\n' "$MOCK_HEALTH"
    BASH
    FileUtils.chmod(0o755, fake_curl)

    marker = File.join(tmp, "observe-bypass-ran")
    hook = File.join(tmp, "bash-env-hook")
    File.write(hook, "printf bypassed > \"$BYPASS_MARKER\"\n")
    process_env = {
      "BASH_ENV" => hook,
      "BYPASS_MARKER" => marker,
      "PATH" => "#{tmp}:#{ENV.fetch("PATH")}",
      "MOCK_HEALTH" => JSON.generate({ "build" => { "git_sha" => expected_sha } })
    }.merge(observe_env).merge("EXPECTED_GIT_SHA" => expected_sha)
    command!("bash", "-c", observe_script, chdir: tmp, env: process_env)
    assert_contract(!File.exist?(marker),
                    "live observation environment executed inherited BASH_ENV")

    fast_failure_script = observe_script
                          .sub("deadline_seconds=2400", "deadline_seconds=1")
                          .sub("sleep 15", "sleep 0.05")
    mismatch_env = process_env.merge(
      "MOCK_HEALTH" => JSON.generate({ "build" => { "git_sha" => other_sha } })
    )
    assert_contract(command_fails?("bash", "-c", fast_failure_script,
                                   chdir: tmp, env: mismatch_env),
                    "live observation accepted a different healthy commit")
  end
end

begin
  workflow = YAML.safe_load(File.read(WORKFLOW_PATH), aliases: false)
  publish_script = validate_workflow!(workflow)
  assert_negative_mutations!(workflow)
  assert_verification_environment!(VERIFICATION_ENV)
  assert_publish_behavior!(publish_script, PUBLISH_ENV)
  assert_observe_behavior!(OBSERVE_SCRIPT, OBSERVE_ENV)
  puts "deploy-vps contract: ok"
rescue ContractError, KeyError, TypeError => e
  warn "deploy-vps contract: #{e.message}"
  exit 1
end
