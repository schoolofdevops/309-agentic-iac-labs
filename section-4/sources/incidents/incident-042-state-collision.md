# Incident 042: Queue State Collision

**Source ID:** OBS-INCIDENT-042  
**Observed:** 2026-05-14T09:20:00Z  
**Trust:** Direct incident record  
**Owner:** Platform operations

A test cleanup used shared Terraform state and selected a production queue resource. The apply was stopped during review before deletion.

Corrective action: separate environment state, add an environment ownership check, and supersede ADR 0002. This incident explains why the current policy is stricter. It does not describe the latest validation result.
