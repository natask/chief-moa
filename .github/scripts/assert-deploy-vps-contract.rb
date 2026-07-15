#!/usr/bin/env ruby
# frozen_string_literal: true

require "fileutils"
require "open3"
require "tmpdir"
require "yaml"

ROOT = File.expand_path("../..", __dir__)
WORKFLOW_PATH = File.join(ROOT, ".github/workflows/deploy-vps.yml")
CHECKOUT_ACTION = "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5".freeze
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
  triggers = workflow["on"] || workflow[true] # Psych uses YAML 1.1 booleans.
  jobs = workflow.fetch("jobs")
  verify_job = jobs.fetch("deploy")
  publish_job = jobs.fetch("publish")

  assert_contract(triggers.fetch("push").fetch("branches") == ["master"],
                  "push trigger must target only master")
  assert_contract(triggers.key?("pull_request"),
                  "pull requests must run verification")
  contract_path = ".github/scripts/assert-deploy-vps-contract.rb"
  assert_contract(triggers.fetch("push").fetch("paths").include?(contract_path),
                  "push trigger must include the contract assertion")
  assert_contract(triggers.fetch("pull_request").fetch("paths").include?(contract_path),
                  "pull request trigger must include the contract assertion")
  assert_contract(workflow.fetch("permissions").fetch("contents") == "read",
                  "workflow default contents permission must remain read-only")
  assert_contract(verify_job.fetch("permissions", {}).fetch("contents", "read") == "read",
                  "verification job must not have write authority")
  assert_contract(publish_job.fetch("needs") == "deploy",
                  "publication must depend on successful gateway verification")
  assert_contract(publish_job.fetch("permissions").fetch("contents") == "write",
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
      "with" => { "ref" => "${{ github.sha }}" }
    },
    {
      "name" => "Publish vps-deploy ref",
      "shell" => "bash",
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
end

def assert_publish_behavior!(publish_script)
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
    command!("bash", "-c", publish_script, chdir: source,
             env: { "GITHUB_SHA" => verified_sha })
    published_sha = command!("git", "--git-dir", remote, "rev-parse",
                             "refs/heads/vps-deploy", chdir: tmp).strip
    assert_contract(published_sha == verified_sha,
                    "publication did not advance vps-deploy to exact GITHUB_SHA")

    # Once master and vps-deploy advance, the older run must fail closed and
    # leave the newer deployment candidate in place.
    command!("git", "push", "origin", "master", chdir: source)
    command!("git", "push", "origin", "master:refs/heads/vps-deploy", chdir: source)
    stale_failed = command_fails?("bash", "-c", publish_script, chdir: source,
                                  env: { "GITHUB_SHA" => verified_sha })
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
  assert_publish_behavior!(publish_script)
  puts "deploy-vps contract: ok"
rescue ContractError, KeyError, TypeError => e
  warn "deploy-vps contract: #{e.message}"
  exit 1
end
