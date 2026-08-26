#!/usr/bin/env bash

set -u

tested_ram_bytes=$((7 * 1024 * 1024 * 1024))
tested_cpu_count=4
tested_disk_bytes=$((20 * 1024 * 1024 * 1024))
tool_output=$(mktemp)
trap 'rm -f "$tool_output"' EXIT

memory_bytes() {
  case "$(uname -s)" in
    Darwin) sysctl -n hw.memsize 2>/dev/null ;;
    Linux) awk '/MemTotal/ {printf "%.0f\n", $2 * 1024}' /proc/meminfo 2>/dev/null ;;
    *) return 1 ;;
  esac
}

cpu_count() {
  case "$(uname -s)" in
    Darwin) sysctl -n hw.logicalcpu 2>/dev/null ;;
    Linux) getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null ;;
    *) return 1 ;;
  esac
}

free_disk_bytes() {
  df -Pk . 2>/dev/null | awk 'NR == 2 {printf "%.0f\n", $4 * 1024}'
}

format_gb() {
  awk -v bytes="$1" 'BEGIN {printf "%.1f GB", bytes / 1024 / 1024 / 1024}'
}

report_resource() {
  local label="$1"
  local detected="$2"
  local tested="$3"
  local tested_label="$4"
  local value="$5"

  if [ -z "$detected" ]; then
    printf '%-10s %-8s %s\n' 'INFO' "$label" 'could not be detected; continue with the lab'
  elif [ "$detected" -lt "$tested" ]; then
    printf '%-10s %-8s %s is below the tested %s; continue with the lab\n' 'WARN' "$label" "$value" "$tested_label"
  else
    printf '%-10s %-8s %s\n' 'OK' "$label" "$value"
  fi
}

report_tool() {
  local label="$1"
  local command_name="$2"
  shift 2

  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf '%-10s %-16s %s\n' 'NOT FOUND' "$label" "command: $command_name"
    return
  fi

  : > "$tool_output"
  if "$command_name" "$@" >"$tool_output" 2>&1; then
    printf '%-10s %-16s %s\n' 'AVAILABLE' "$label" "$(sed -n '1p' "$tool_output")"
  else
    printf '%-10s %-16s %s\n' 'NOT READY' "$label" "$(sed -n '1p' "$tool_output")"
  fi
}

ram=$(memory_bytes || true)
cpus=$(cpu_count || true)
disk=$(free_disk_bytes || true)

printf 'Agentic IaC Section 1 preflight report\n'
printf 'The tested reference profile is 7 GB RAM, 4 logical CPUs, and 20 GB free disk.\n'
printf 'Lower values produce a warning, not a failure.\n\n'

printf 'System profile\n'
report_resource 'RAM' "$ram" "$tested_ram_bytes" '7 GB baseline' "$(if [ -n "$ram" ]; then format_gb "$ram"; else printf 'unknown'; fi)"
report_resource 'CPU' "$cpus" "$tested_cpu_count" '4-CPU baseline' "${cpus:-unknown} logical CPUs"
report_resource 'Disk' "$disk" "$tested_disk_bytes" '20 GB baseline' "$(if [ -n "$disk" ]; then format_gb "$disk"; else printf 'unknown'; fi) free"

printf '\nInfrastructure tools\n'
report_tool 'Git' git --version
report_tool 'Docker' docker version --format 'Docker server {{.Server.Version}}'
report_tool 'Terraform' terraform version
report_tool 'OpenTofu' tofu version

printf '\nCoding agents and interfaces (optional)\n'
report_tool 'Codex' codex --version
report_tool 'Claude Code' claude --version
report_tool 'Goose' goose --version
report_tool 'Cursor' cursor --version
report_tool 'GitHub Copilot' copilot --version
report_tool 'VS Code' code --version
report_tool 'Gemini CLI' gemini --version
report_tool 'Aider' aider --version
report_tool 'OpenCode' opencode --version

printf '\nREADY     Preflight report complete. Warnings and missing optional agents do not block Section 1.\n'
