---
name: gentle-ai-architecture-gate
description: "Trigger: choosing a runtime or storage engine, adding a backend/service, or reviewing an architect ADR. Greenfield inference, brownfield refutation, 10x failure audit."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

# Architecture Gate Rubric (v2 — Greenfield & Brownfield)

This rubric feeds `gentle-ai-architect`, which loads it before engine routing, and any reviewer checking an architect ADR, so ignoring the forensic diagnosis or bolting a generic patch onto an existing system fails.

## 1. Domain-to-Physics Inference Table (When User Gives Zero Specs)
When a prompt lacks technical metrics, map the domain intent to these baseline physical profiles:
- **Analytics / Events / Logs / Tracking:** Write-heavy append-only. Default to MVP scale (tens of writes per second, single node): a single-node engine (SQLite WAL, DuckDB, or a store the team already operates) is enough. Only when the prompt signals a device fleet, high-frequency sampling, or multi-tenant ingestion → **Columnar (ClickHouse / DuckDB)** + compiled batcher (**Go / Rust**). Declare which profile was assumed.
- **Transactional Core / Billing / Inventory / Users:** Point lookups + ACID invariants → **B-Tree (SQLite WAL for single-node; PostgreSQL for multi-node)** + typed backend (**Go / Rust / Java**).
- **Queues / Webhooks / Real-time Streams:** High concurrency + ephemeral state → **Log/Stream Broker (NATS JetStream / Valkey)**.
- **Search / Full-text / Vectors:** Inverted index / HNSW → **Meilisearch / Qdrant / Tantivy** (never brute-force `LIKE` or unindexed vector scans on OLTP DBs).

Every routing choice also weighs operational and team cost: who operates it, backups, monitoring, and the language the team already knows. A familiar stack (PostgreSQL, Node.js, Python) is valid when the workload physics fit and that operational justification is written down; an exotic engine the workload does not need is a defect too.

## 2. Brownfield Anti-Patterns (Mandatory Refutation Triggers)
When inspecting an existing repository, the Architect MUST flag and refute any of the following:
1. **The "Postgres-Does-Everything" Trap:** Using an existing PostgreSQL instance as a high-throughput message queue (`SKIP LOCKED` polling), time-series store without partitioning, or heavy OLAP engine alongside live user transactions.
2. **The "Rewrite Everything" Trap:** Proposing to rewrite a working monolith in Rust/C++ when a **Sidecar Offload** (extracting only the bottleneck endpoint/worker) solves the physical limit in 10% of the time.
3. **Unbounded Runtime in Bounded Containers:** Running JVM (without `-XX:MaxRAMPercentage`), Node.js, or multi-worker Python inside containers capped below 512 MB RAM.

## 3. Reviewer Rejection Criteria (Hard Fail)
A downstream implementation or architectural plan FAILS review if:
1. It halts without a concrete recommendation simply because the user did not specify WPS, IOPS, or RAM.
2. It ignores existing `Dockerfile` / `docker-compose.yml` resource limits or existing database anti-patterns in the repo.
3. It introduces PostgreSQL, MongoDB, Python, or Node.js without documenting either why specialized alternatives failed the workload physics or the operational justification (team skills, existing operations, backups, monitoring) that makes the familiar choice fit; or it introduces an exotic engine the workload does not need.
4. It omits the 10x physical failure mode or the `Immutable Boundaries for Writers`.
