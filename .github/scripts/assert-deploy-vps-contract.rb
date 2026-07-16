#!/usr/bin/env ruby
# frozen_string_literal: true

require "fileutils"
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
VERIFY_SCRIPT = <<~'BASH'
  set -euo pipefail
  bash -n scripts/vps/*.sh
  bash scripts/vps/test-node-runtime.sh
  bash scripts/vps/test-preview-tls-proxy.sh
  bash scripts/vps/test-install-promotion-control-plane.sh
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
  assert_contract(jobs.keys.sort == %w[deploy publish],
                  "workflow must contain only verification and publication jobs")
  verify_job = jobs.fetch("deploy")
  publish_job = jobs.fetch("publish")

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

begin
  workflow = YAML.safe_load(File.read(WORKFLOW_PATH), aliases: false)
  publish_script = validate_workflow!(workflow)
  assert_negative_mutations!(workflow)
  assert_verification_environment!(VERIFICATION_ENV)
  assert_publish_behavior!(publish_script, PUBLISH_ENV)
  puts "deploy-vps contract: ok"
rescue ContractError, KeyError, TypeError => e
  warn "deploy-vps contract: #{e.message}"
  exit 1
end
