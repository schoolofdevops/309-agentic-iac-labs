# Job Queue Module Contract

**Source ID:** SRC-MODULE-JOB-QUEUE-2.1  
**Version:** 2.1  
**Updated:** 2026-08-18  
**Trust:** Direct owning-module contract  
**Owner:** Platform engineering

The Terraform queue module owns the queue, dead-letter queue, access-policy resources, and non-secret identifiers. Each environment supplies a distinct state and queue name.

Helm receives queue endpoint references. Application configuration owns retry behaviour and job transitions. Secret management owns credential values. GitOps promotes reviewed workload configuration.

The module contract does not authorize apply. Validation must stop before infrastructure changes.
