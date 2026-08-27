# ADR 0002: Share Queue State Between Test and Production

**Source ID:** SRC-ADR-0002  
**Version:** 1.0  
**Updated:** 2025-02-10  
**Status:** Superseded  
**Trust:** Historical architecture record

## Decision

Test and production may share one Terraform state to reduce initial setup work. Queue names distinguish the two environments.

## Supersession note

Current IaC policy 2026.08 supersedes this decision after Incident 042 showed that a shared-state operation could claim the wrong environment's queue.
