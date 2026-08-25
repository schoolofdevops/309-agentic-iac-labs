#!/usr/bin/env bash
set -euo pipefail

minimum_ram_bytes=$((7 * 1024 * 1024 * 1024))

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    printf 'MISSING  %s\n' "$name" >&2
    return 1
  fi
}

memory_bytes() {
  case "$(uname -s)" in
    Darwin) sysctl -n hw.memsize ;;
    Linux) awk '/MemTotal/ {print $2 * 1024}' /proc/meminfo ;;
    *) return 1 ;;
  esac
}

printf 'Agentic IaC Section 1 preflight\n'
printf 'Baseline: 7 GB RAM, 4 logical CPUs, 20 GB free disk\n\n'

for tool in git docker terraform tofu; do
  require_command "$tool"
done

git --version
docker version --format 'Docker server {{.Server.Version}}'
terraform version | head -n 1
tofu version | head -n 1

ram="$(memory_bytes)"
if [ "$ram" -lt "$minimum_ram_bytes" ]; then
  printf 'FAIL     detected RAM is below the 7 GB course baseline\n' >&2
  exit 1
fi
printf 'PASS     machine meets the 7 GB RAM course baseline\n'

if [ -f "phase-0/p0-agent-terraform/task.md" ]; then
  printf 'PASS     learner lab repository detected\n'
else
  printf 'NOTE     run this script from the 309-agentic-iac-labs repository root\n'
fi

printf '\nPASS     preflight complete; choose any compatible coding agent for later labs.\n'
