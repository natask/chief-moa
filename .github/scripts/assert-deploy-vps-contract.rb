#!/usr/bin/env ruby
# frozen_string_literal: true

require "fileutils"
require "open3"
require "tmpdir"
require "yaml"

ROOT = File.expand_path("../..", __dir__)
WORKFLOW_PATH = File.join(ROOT, ".github/workflows/deploy-vps.yml")

def fail_contract(message)
  warn "deploy-vps contract: #{message}"
  exit 1
end

def assert_contract(condition, message)
  fail_contract(message) unless condition
end

def command!(*command, chdir:, env: {})
  stdout, stderr, status = Open3.capture3(env, *command, chdir: chdir)
  return stdout if status.success?

  fail_contract("#{command.join(' ')} failed:\n#{stdout}#{stderr}")
end

workflow = YAML.safe_load(File.read(WORKFLOW_PATH), aliases: false)
triggers = workflow["on"] || workflow[true] # Psych uses YAML 1.1 booleans.
jobs = workflow.fetch("jobs")
verify_job = jobs.fetch("deploy")
publish_job = jobs.fetch("publish")

assert_contract(triggers.fetch("push").fetch("branches") == ["master"],
                "push trigger must target only master")
assert_contract(triggers.key?("pull_request"), "pull requests must run verification")
contract_script_path = ".github/scripts/assert-deploy-vps-contract.rb"
assert_contract(triggers.fetch("push").fetch("paths").include?(contract_script_path),
                "push trigger must include the contract assertion")
assert_contract(triggers.fetch("pull_request").fetch("paths").include?(contract_script_path),
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

publish_steps = publish_job.fetch("steps").select do |step|
  step["name"] == "Publish vps-deploy ref"
end
assert_contract(publish_steps.length == 1, "expected exactly one ref publication step")
publish_script = publish_steps.first.fetch("run")
commands = publish_script.lines.map(&:strip).reject(&:empty?)
expected_publish = 'git push --atomic --force origin "${GITHUB_SHA}:refs/heads/vps-deploy"'
assert_contract(commands.last == expected_publish,
                "atomic ref update must be the publication job's final command")

# Exercise the workflow's actual shell against a local bare remote. HEAD is
# intentionally newer than GITHUB_SHA, proving the step targets the event SHA
# rather than whichever commit happens to be checked out.
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

  File.write(File.join(source, "candidate.txt"), "newer checkout\n")
  command!("git", "commit", "-am", "test: newer checkout", chdir: source)
  head_sha = command!("git", "rev-parse", "HEAD", chdir: source).strip
  assert_contract(head_sha != verified_sha, "test setup did not create distinct SHAs")

  command!("bash", "-c", publish_script, chdir: source,
           env: { "GITHUB_SHA" => verified_sha })
  published_sha = command!("git", "--git-dir", remote, "rev-parse",
                           "refs/heads/vps-deploy", chdir: tmp).strip
  assert_contract(published_sha == verified_sha,
                  "publication did not advance vps-deploy to exact GITHUB_SHA")
end

puts "deploy-vps contract: ok"
