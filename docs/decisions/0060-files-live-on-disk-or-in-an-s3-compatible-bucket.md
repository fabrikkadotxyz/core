# 0060 — Files live on disk, or in an S3-compatible bucket the operator names

**Status:** Proposed
**Date:** 2026-10-21
**Amended by:** [ADR 0061](0061-a-face-for-everyone-a-picture-for-people-who-want-one.md):
the store gains a delete, used only for profile pictures.
**Builds on:** [ADR 0013](0013-context-is-append-only-with-explicit-removal.md)
(artifacts are content-addressed; that half stands), and M39's promise that
a self-hoster needs nothing beyond the container and Postgres.

## Context

Since M8 an uploaded file is a blob on the server's disk, named by the SHA-256
of its content, under `ARTIFACT_DIR`. That was right for a self-hoster: no
object storage to configure to attach a CSV.

It stops being right in three places. A hosted instance on a platform whose
disk is small, single-attached or ephemeral (Render's disk is one machine's,
Fly's volumes are per region) cannot run two server instances, and loses the
files with the volume. GDPR's data-residency question ("where do our files
live?") wants an answer the operator picks, often an EU bucket, rather than
wherever the container happens to run. And the backup (M61) had to copy a
directory that grows without bound.

Every object store worth naming speaks the S3 API: AWS S3, Cloudflare R2,
Backblaze B2, Wasabi, DigitalOcean Spaces, Scaleway, Hetzner, MinIO and
Garage. One driver covers all of them, if it takes an endpoint URL.

## Decision

**1. The operator picks, per instance.** `FABRIKKA_FILES` is `disk` (the
default, unchanged) or `s3`. It is an instance setting, in the environment,
next to `DATABASE_URL`: credentials for a bucket are the operator's, like the
database's, and never something a person in a room types. One instance has
one store; there is no per-organization bucket.

**2. S3 means any S3-compatible endpoint.** The bucket is named by
`FABRIKKA_S3_ENDPOINT` (a URL; empty means AWS for the region),
`FABRIKKA_S3_BUCKET`, `FABRIKKA_S3_REGION` (default `us-east-1`; R2 takes
`auto`), `FABRIKKA_S3_ACCESS_KEY_ID`, `FABRIKKA_S3_SECRET_ACCESS_KEY`, and
optionally `FABRIKKA_S3_PREFIX` and `FABRIKKA_S3_PATH_STYLE`. Path-style
addressing is the default when an endpoint is given, because MinIO and most
self-hosted stores need it, and virtual-hosted style when it is not, as AWS
prefers.

**3. Same keys in both.** A file's key is its hash, sharded as on disk:
`ab/cd/abcd…`. The bucket under its prefix is the same tree as
`ARTIFACT_DIR`, so moving between them is a copy, and the database's
`storage_key` never changes. Written once, never overwritten (the content is
the name), never deleted by Fabrikka: deleting a file or a retention prune
removes the row, as on disk, because another row may share the blob.

**4. Bytes go through Fabrikka, never around it.** A download is read by the
server and served under the room's membership check, exactly as from disk.
No presigned URL, no public bucket, no redirect: a link to a bucket would be
a capability that outlives a person's place in the room, and the bucket
should stay private. The cost is that the server carries the bytes, which
at 10 MB per file is fine.

**5. A store that does not answer stops the server.** With `FABRIKKA_FILES=s3`
the server writes and reads back a small check object at start. If that
fails, it refuses to start and says why (wrong key, no bucket, wrong region,
unreachable endpoint). It never falls back to disk: half the files in each
place is worse than a server that does not start.

**6. No SDK.** The driver signs its own requests (AWS Signature Version 4,
about a hundred lines on `node:crypto`) and speaks four calls: put, get, head
and list. The AWS SDK would be the largest dependency in the server for four
requests. The signer is tested against AWS's published example.

**7. Moving, and the backup.** `fabrikka admin files copy --to s3` (or
`--to disk`) copies every blob from the other store into the configured one,
skipping what is already there, so it can be rerun; then the operator
changes `FABRIKKA_FILES` and restarts. `fabrikka admin files status` says
which store is in use and whether every file row has its blob. The backup
reads from, and a restore writes into, whichever store is configured. The
archive format does not change, so an archive taken from disk restores into
a bucket.

## Consequences

- A hosted instance can run on any platform's ephemeral disk, in any region
  its bucket is in, and more than one server can share the files.
- The bucket's region is the files' region. The operator who wants an EU
  answer for GDPR picks an EU bucket; Fabrikka has nothing more to say.
- The bucket's own durability and versioning are the operator's. The daily
  backup still copies every file, which for a large bucket is slow; a
  later milestone may let a bucket with versioning skip it.
- The secret key is in the environment like the database password, and is
  never logged; the start line names the endpoint, bucket and prefix only.
- Profile pictures (the next milestone) are files too, and use the same store
  and the same keys.

## Not decided here

Per-organization buckets (bring your own bucket), server-side encryption
settings beyond the bucket's default, and garbage-collecting unreferenced
blobs. Each would need its own decision.
