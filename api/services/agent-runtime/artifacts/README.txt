# Prototype compiler (internal module path retained)

Retained: readSnapshot, compileArtifact, fixed dependency resolution, HTML policy,
worker time/memory limits, compiler-owned minimal ready/theme/resize bootstrap.
No publisher, store, version, state, feedback, export, jobs or recovery remain.
Completed assistant declarations are handled by ../prototype-integration.ts and
stored atomically in existing message metadata. Historical migrations stay intact.
