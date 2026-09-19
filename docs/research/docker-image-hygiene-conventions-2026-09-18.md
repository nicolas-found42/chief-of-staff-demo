# Docker image hygiene and legible Docker flows: duplicates, cleanup primitives, conventions

_Researched 2026-09-18 against primary sources: the Docker CLI and Compose reference at
docs.docker.com (build, down, run, watch, prune, project-name, merge, cache, attestations,
volumes), the `docker/compose` sources at the `v5.5.1` tag this workstation runs
(`pkg/compose/down.go`, `pkg/compose/image_pruner.go`, `pkg/compose/images.go`), the issue/PR
trail that owns the "does an identical rebuild return the same image?" question
(docker/compose#13636, docker/compose#13949, moby/buildkit#3552), GitHub's runner and expression
documentation, and the actual files of the projects used as convention evidence: supabase/supabase,
getsentry/self-hosted,
jupyter/docker-stacks, n8n-io/n8n, nextcloud/docker, immich-app/immich, go-gitea/gitea,
calcom/cal.diy (cal.com), keploy/keploy, openemr/openemr, getredash/redash, hyperdxio/hyperdx,
docker/awesome-compose and playwright.dev's Docker page. Motivated by the 2026-09-18
isolated acceptance run for issue #423: it built the repo under its own Compose project with a
run-specific tag (`issue-423-journeys:local`, 4.06 GB) and left that image behind, which reads as
a second application on this machine. Read-only local commands (`docker image ls/inspect/history`,
`docker ps`, `docker system df`, `docker volume ls`, `docker compose ls -a`) were used for the
local observations below; the only state-changing command run for this note was
`docker compose build app`, twice, to observe the rebuild-identity behavior measured in 1.6 - no
`up`, `run`, `down`, `pull`, `prune`, or `rm` was run._

## Verdicts at a glance

| Question | Verdict | Owner of the answer |
|---|---|---|
| After an input-identical `docker compose build`, does Docker return the same image? | **Store-dependent, and "same" needs a definition.** Classic image store: yes, "the second build reuses the cache completely and the image ID stays the same". Containerd image store with BuildKit's default provenance: the build is stored as an attested index whose top-level digest "churns on every build even when the runnable content is unchanged" - and that top-level digest is what `docker image ls` prints. The runnable content (platform manifest = config + layers) is deterministic; Compose v5.5.1 compares that, which is why it no longer recreates containers. No single doc states the rule; the compose issue and its merged fix do. | [docker/compose#13636](https://github.com/docker/compose/issues/13636), [docker/compose#13949](https://github.com/docker/compose/pull/13949), [moby/buildkit#3552](https://github.com/moby/buildkit/issues/3552) |
| Where do duplicate images come from? | A rebuild moves the tag; the previously tagged image stays in the store, untagged, until pruned (on the containerd store with unchanged content, the daemon drops it outright - 1.1). A differently named Compose project multiplies *default* (`<project>-<service>`) names. A run-specific `image:` tag creates a second reference nobody will ask for again. Watch mode deletes superseded dangling images; a plain `build` does not. | [Prune unused objects](https://docs.docker.com/engine/manage-resources/pruning/), [compose build](https://docs.docker.com/reference/cli/docker/compose/build/), [compose watch](https://docs.docker.com/compose/how-tos/file-watch/) |
| `down --rmi local` vs `--rmi all` | The CLI help says `local` removes "only images that don't have a custom tag". The shipped v5.5.1 implementation removes every image **labeled with this project** that belongs to a known service - including a service that sets `image:` explicitly - plus the implicit `<project>-<service>` names of services without `image:`. `all` adds the images explicitly named in the file (pulled ones included). Trust the source over the one-line help. | [compose down reference](https://docs.docker.com/reference/cli/docker/compose/down/), [`image_pruner.go`](https://github.com/docker/compose/blob/v5.5.1/pkg/compose/image_pruner.go) |
| `image prune` vs `image prune -a` vs `system prune` | `image prune`: dangling only. `-a`: every image not referenced by a container. `system prune`: stopped containers + unused networks + dangling images + unused build cache; volumes only with `--volumes`, and then anonymous ones only. | [Prune unused Docker objects](https://docs.docker.com/engine/manage-resources/pruning/) |
| What keeps anonymous volumes around? | An image-declared `VOLUME` with no Compose mapping gets a fresh anonymous volume per container creation; anonymous volumes survive container removal (unless `docker run --rm`), and Compose `down` leaves them. `docker volume prune` removes exactly those, by default. Our 36 dangling volumes are this mechanism applied to searxng's `/var/cache/searxng`. | [Volumes](https://docs.docker.com/engine/storage/volumes/), [volume prune](https://docs.docker.com/reference/cli/docker/volume/prune/), [compose down](https://docs.docker.com/reference/cli/docker/compose/down/), local observation |
| The conventions real projects converge on | One compose file plus overrides/`-f` layers; canonical image names; a single wrapper command that owns up/down/logs/clean; an explicit tag scheme (semver / `vX.Y.Z` / immutable `version-sha`); CI as an ephemeral, cache-scoped, always-cleaned machine. | [Merge Compose files](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/) plus the project repos cited below |

## 1. Where duplicate images and containers come from

### 1.1 A rebuild moves a tag; the superseded image is left untagged - or dropped

Docker's pruning page defines the residue precisely: "By default, `docker image prune` only
cleans up _dangling_ images. A dangling image is one that isn't tagged, and isn't referenced by
any container" ([Prune unused Docker objects](https://docs.docker.com/engine/manage-resources/pruning/)).
The same page's `system prune` section is explicit about how far `-a` / `--all` reaches: "Unused
tagged images are kept unless you also pass `-a` / `--all`", and for images alone
`docker image prune -a` warns it "will remove all images without at least one container associated
to them" ([Prune unused Docker objects](https://docs.docker.com/engine/manage-resources/pruning/),
[image prune](https://docs.docker.com/reference/cli/docker/image/prune/)).

Why a rebuild produces one: rebuilding an image under an existing tag rebinds that tag to the new
image; the previous image loses its only reference. Compose documents this for its watch loop,
where it also documents the cleanup:

> When a service is rebuilt, the previous image version becomes dangling. By default, Compose
> removes these superseded dangling images after each rebuild to avoid accumulating unused layers.
> To keep them, use `docker compose watch --prune=false`.
> - [Use Compose Watch](https://docs.docker.com/compose/how-tos/file-watch/)

Two consequences that matter here. First, that automatic removal is a *watch* behavior
(`docker compose watch --prune` defaults to `true` per the
[watch reference](https://docs.docker.com/reference/cli/docker/compose/watch/)); a plain
`docker compose build` or `docker compose up --build` does not document any such cleanup, so the
superseded image sits until `docker image prune` or `down --rmi` runs. Second, a *tagged* leftover
is invisible to `docker image prune`: the 4.06 GB `issue-423-journeys:local` image would have
survived `docker image prune -f` for as long as its tag existed, because prune only removes
dangling images (and `-a` would also remove the canonical images' ancestry, which is exactly the
flag the pruning page tells you to be careful with).

One store nuance matters before the rest of this note: on the containerd image store, a rebuild
whose runnable content is unchanged does not leave an untagged image behind at all. After this
note's two verification builds (1.6), `docker image ls -a` showed only the four tagged images, and
the index the running app container was created from no longer inspects (`No such image`). The
v5.5.1 source states the behavior: "under the containerd image store the daemon drops the dangling
old index when a rebuild with identical content moves the tag - without compose recreating the
container" ([`images.go`](https://github.com/docker/compose/blob/v5.5.1/pkg/compose/images.go)).
The dangling residue this section describes is therefore the classic-store shape; on c8d with
unchanged content there is nothing for `prune` to find.

### 1.2 Default image names are project-scoped; pinned names are not

Compose's build reference states the naming rule: "Services are built once and then tagged, by
default as `project-service`", and "If the Compose file specifies an
[image](https://github.com/compose-spec/compose-spec/blob/main/spec.md#image) name, the image is
tagged with that name" ([compose build](https://docs.docker.com/reference/cli/docker/compose/build/)).

The project name is what varies: "By default, Compose assigns the project name based on the name
of the directory that contains the Compose file", overridable by `-p` or `COMPOSE_PROJECT_NAME`,
and the docs name our exact use case: "On a CI server: Prevent interference between builds by
setting the project name to a unique build number"
([Specify a project name](https://docs.docker.com/compose/how-tos/project-name/)).

So an isolated run has two shapes:

- **No `image:` on the service** - project `issue-423` and project `chief-of-staff-demo` each build
  their own `issue-423-app` / `chief-of-staff-demo-app` image. Same content, two names, two
  entries in `docker image ls`, and only the project you run `down --rmi` on can clean its own.
- **Pinned `image:`** (our compose file) - both projects build to the same tag. The tag follows
  whichever build ran last; nothing is duplicated by name, but the image the tag used to point at
  becomes dangling (or, on the containerd store with unchanged content, is dropped - 1.1), and an
  isolated run that rebuilds the canonical names has to accept that it has moved the project's
  canonical images.

### 1.3 `docker compose run` leaves one-off containers unless told otherwise

`docker compose run` "Runs a one-time command against a service" and deliberately differs from
`up`: it "does not create any of the ports specified in the service configuration", and its
`--rm` option "Automatically remove the container when it exits" - which is opt-in
([compose run reference](https://docs.docker.com/reference/cli/docker/compose/run/)). Without it,
the stopped one-off container stays in `docker ps -a` and counts as a reference to the image
(relevant to `image prune -a`), and its writable layer keeps costing disk. The pruning page is
blunt about the accumulation: "A stopped container's writable layers still take up disk space. To
clean this up, you can use the `docker container prune` command"
([Prune unused Docker objects](https://docs.docker.com/engine/manage-resources/pruning/)).

### 1.4 Multi-stage `target:` builds produce different images from one Dockerfile

Multi-stage builds exist to keep intermediates out of the final image: "You can selectively copy
artifacts from one stage to another, leaving behind everything you don't want in the final image",
and with BuildKit "only builds the stages that the target stage depends on"
([Multi-stage builds](https://docs.docker.com/build/building/multi-stage/)). Compose exposes this
in the file model: `target` "defines the stage to build as defined inside a multi-stage
`Dockerfile`" ([build reference](https://docs.docker.com/reference/compose-file/build/) - the
`docker compose build` CLI reference has no `target` flag). A repo that builds
two targets (say `production` and `debug`) from one Dockerfile under the *same* tag is asking for
tag thrash: each build moves the tag to a different image, and the other target's image becomes
dangling. The common fix is distinct tag suffixes per target, not a cleanup script. In practice the
target is selected explicitly: Compose's own `build.target` example is `build: {context: ., target:
prod}` ([build reference](https://docs.docker.com/reference/compose-file/build/)), and
supabase builds its studio image with `target: production` under `cache-from: type=gha` /
`cache-to: type=gha,mode=max`, while the arm release job deliberately sets `no-cache: true`
([`publish_image.yml`](https://github.com/supabase/supabase/blob/master/.github/workflows/publish_image.yml)).

### 1.5 BuildKit cache: what it costs, what it buys

The build cache is local to the builder and is what makes a rebuild cheap; our machine is a good
example: `docker system df` reports **25.9 GB of build cache with 21.47 GB reclaimable** (252
records, 0 in use) against 4.88 GB of images, while the repo's README prices a cache-warm rebuild
at about half a minute. `docker buildx prune` "clears the build cache of the selected builder",
and its filters are the documented way to trim without emptying it: `until` "keep[s] records that
have been used in the last duration time" (e.g. `--filter "until=24h"`), with
`--max-used-space`, `--min-free-space`, `--reserved-space` for size-bounded policies
([buildx prune reference](https://docs.docker.com/reference/cli/docker/buildx/prune/)). The
pruning page's general rule - "These objects are generally not removed unless you explicitly ask
Docker to do so" - does not hold for the build cache: BuildKit garbage-collects it on its own
schedule, and "Garbage Collection (GC) runs periodically and follows an ordered list of prune
policies. The BuildKit daemon clears the build cache when the cache size becomes too big, or when
the cache age expires"; "the default GC behavior is sufficient and doesn't require any
intervention"
([Build cache garbage collection](https://docs.docker.com/build/cache/garbage-collection/),
[Prune unused Docker objects](https://docs.docker.com/engine/manage-resources/pruning/)).

Cache mounts are a separate namespace from images: `RUN --mount=type=cache` data lives in the
cache, not the image, and BuildKit "doesn't preserve cache mounts in the GitHub Actions cache by
default" ([Cache management with GitHub Actions](https://docs.docker.com/build/ci/github-actions/cache/)).
That is why our CI's `type=gha` cache accelerates manifest installs without shipping them.

### 1.6 The rebuild-identity question, settled from primary sources and two measured rebuilds

**Question:** after an input-identical `docker compose build` (every step `CACHED`), does Docker
return the SAME image - same ID, same `Created` timestamp?

**Answer: no single document states this rule; the behavior is a property of the image store, and
the "IDs" differ per store.** The trail:

- **[docker/compose#13636](https://github.com/docker/compose/issues/13636)**, "[BUG] `docker
  compose build` produces different image IDs on each rebuild with containerd image store, but
  works correctly with overlay2" (opened 2026-03-14 against Compose v5.1.0, Docker 29.3.0). The
  reporter's second build shows "individual build steps show `CACHED` for RUN/COPY layers, but the
  final image still gets a new ID", and on the classic store "the second build reuses the cache
  completely and the image ID stays the same".
- Maintainer **crazy-max** diagnosed the mechanism in that thread: "With the containerd image
  store, local images can retain attestations/index data. Buildx enables minimal provenance
  attestations by default. Provenance metadata includes per-build fields like
  invocation/timestamps, so you can get a different final image/index digest even when all
  filesystem layers are cached." He also stated the comparison boundary: "Compose should not
  compare that top-level attested image/index digest for this use case ... it probably needs to
  compare the subject platform manifest digest, or possibly the image config digest".
- **BuildKit's own docs** say the same thing structurally: "Provenance attestations with the
  `mode=min` level are added to images by default", and "Attestations attach to an image index"
  ([Build attestations](https://docs.docker.com/build/metadata/attestations/)).
- **[docker/compose#13949](https://github.com/docker/compose/pull/13949)** (merged 2026-07-20,
  shipped by the v5.5.1 this workstation runs) is the fix: "a built image is stored as an attested
  index whose top-level digest also covers the attestation manifest. That digest churns on every
  build even when the runnable content is unchanged, so compose recreated containers on every
  `up --build`." The fix compares "the digest of the 'image' kind manifest ... selected for the
  target platform and restricted to locally available manifests, so it is deterministic and
  reflects only config + layers."
- **[docker/compose#14112](https://github.com/docker/compose/pull/14112)** (merged 2026-08-25)
  closed the related hole where a service's `build.provenance: false` was silently omitted, so
  BuildKit attached an attestation anyway.
- **[moby/buildkit#3552](https://github.com/moby/buildkit/issues/3552)** is the older,
  experimentally-confirmed version of this phenomenon ("differences in my images that are built
  despite all layers being cached", with provenance enabled); its 2026 comment notes the old
  label-based causes were removed in BuildKit v0.12.0 and that "residual nondeterminism in
  inline-cache ordering" is tracked separately. The `type=inline` cache metadata story is a
  buildx-era detail, not our (registry-less, local) shape, but it is the same class of "metadata
  outside the runnable content moves the digest".

**Observed on this machine (2026-09-18, containerd image store, BuildKit defaults).** Two
`docker compose build app` runs, no input changes, recording `.Id`, `.Created` and `.Descriptor`
from `docker image inspect chief-of-staff-demo-app:latest` before and after each:

| Step | Image ID | `Created` | `.Descriptor.mediaType` |
|---|---|---|---|
| before | `sha256:cf2c44234963...` | `2026-09-19T01:06:05.414152589Z` | `application/vnd.oci.image.index.v1+json` |
| after build 1 (re-ran whisper, 33.9 s in log) | `sha256:478a36f34047...` | unchanged | same |
| after build 2 (0.98 s, every step `CACHED`) | `sha256:e8912ece3f4a...` | unchanged | same |

Both builds exported the same config (`sha256:b9d419ad9e8f...`) and platform manifest
(`sha256:384386fc1570...`) while the attestation manifest differed
(`sha256:eca7d61b...` -> `sha256:43b97d13...`); build 1 only re-fetched a base-image layer the
store had reclaimed and re-ran the whisper stage, and build 2 was satisfied entirely from cache.
So the ID churned on every build while `Created` never moved, and the tag stayed an attested OCI
index. After both builds `docker image ls -a` showed only the four tagged images; the superseded
indexes - including the one the running app container was created from - no longer inspect
(`No such image`).

The relay service is the same story with no watch entries to explain it: only `app` has
`develop.watch` entries in `docker-compose.yml`, so watch-triggered rebuilds never touch relay -
only an explicit build does. The relay container has run since `2026-09-18T07:39:26.680408255Z`
(03:39 local) from `sha256:61ada657d954...`, an image the daemon no longer holds; the
`chief-of-staff-demo-relay:latest` tag holds a different build, `sha256:acb49b27fb9e...`
(`Created` `2026-09-14T16:40:40.070532094Z`). One relay build did run after 09-14 - the ID churn
measured above is how a cache-satisfied relay rebuild lands on a new index digest - and the image
the container still runs from is no longer in the store. The history does not support the reading
that relay was never rebuilt.

**What this means in practice, precisely:**

| Store | `docker image ls` ID after a fully cached identical rebuild | Same `Created`? |
|---|---|---|
| Classic image store (overlay2) | Same image ID (reporter-confirmed on #13636) | No primary statement; the config that carries `created` is a cached build result, so nothing re-stamps it (the mechanism the c8d builds above demonstrate) |
| Containerd image store + default provenance (this Mac) | Different ID on every build: observed `cf2c44234963...` -> `478a36f34047...` -> `e8912ece3f4a...` across two builds; `docker image ls` prints the top-level index digest, which covers the attestation manifest (#13949) | **Yes** - observed unchanged (`2026-09-19T01:06:05.414152589Z`) after both builds: the config that carries `created` is a cache hit, and only the index's attestation manifest (`eca7d61b...` -> `43b97d13...`) is new |
| Either store, `--provenance=false` / `BUILDX_NO_DEFAULT_ATTESTATIONS=1` | Same platform manifest either way; on c8d the ID stops churning (the workaround the reporter confirmed in #13636) | Same as classic |

The honest summary: **"the build fully cache-hits, therefore it is the same image" is true about
the runnable content and false about the top-level ID on a store that keeps attestations.** The
`Created` half is observed, not inferred: both builds above kept the same timestamp while the ID
changed, because the config is a cache hit and only the index's attestation manifest is new. If
any tooling of ours compares `docker image ls` IDs to decide "did the image change?", it is
comparing the wrong boundary - Compose itself did exactly that until #13949.

## 2. The cleanup primitives and their exact semantics

| Command | What it removes | What it protects | Owning doc |
|---|---|---|---|
| `docker compose down` | Containers for services in the file, the project's networks | Volumes; images; external networks/volumes ("Networks and volumes defined as external are never removed") | [compose down](https://docs.docker.com/reference/cli/docker/compose/down/) |
| `docker compose down -v` | The above, plus "named volumes declared in the 'volumes' section ... and anonymous volumes attached to containers" | Bind mounts; anything external | same |
| `docker compose down --rmi local` | Images labeled with this project that belong to a known service - explicitly named via `image:` included - plus implicit `<project>-<service>` names, plus (v5.5.1) the project's dangling images | Everything not built by Compose (pulled images with no project label); other projects' images | [`image_pruner.go`](https://github.com/docker/compose/blob/v5.5.1/pkg/compose/image_pruner.go) |
| `docker compose down --rmi all` | `local` plus the images explicitly named in the file, if present locally (registry-only ones included) | Images not named in the file and not project-labeled | same |
| `docker image prune` | Dangling (untagged, unreferenced) images only | Tagged images; images referenced by any container | [image prune](https://docs.docker.com/reference/cli/docker/image/prune/) |
| `docker image prune -a` | All images "without at least one container associated to them" (this includes base images nothing runs) | Images in use by a container | same |
| `docker system prune` | Stopped containers, unused networks, dangling images, unused build cache (incl. BuildKit cache mounts) | Volumes (add `--volumes` for anonymous ones; named ones need `volume prune -a`); tagged/unused images unless `-a` | [Prune unused objects](https://docs.docker.com/engine/manage-resources/pruning/) |
| `docker volume prune` | "Unused local volumes ... not referenced by any containers. By default, it only removes anonymous volumes." | Named volumes (unless `-a`) | [volume prune](https://docs.docker.com/reference/cli/docker/volume/prune/) |
| `docker buildx prune` | Build cache of the selected builder; `--filter until=`, `--max-used-space`, etc. | Images; containers | [buildx prune](https://docs.docker.com/reference/cli/docker/buildx/prune/) |
| `docker compose watch --prune` (default `true`) | Superseded dangling images after each watch rebuild | Anything not dangling | [watch](https://docs.docker.com/compose/how-tos/file-watch/) |

The `--rmi local` subtlety deserves the extra paragraph. The CLI reference describes it as
"Remove images used by services. `local` remove only images that don't have a custom tag
(`local`|`all`)" ([compose down](https://docs.docker.com/reference/cli/docker/compose/down/)).
The v5.5.1 implementation does not test for a "custom tag" at all. `ImagesToPrune` in `local`
mode takes `labeledLocalImages` - `ImageList` filtered by `label=com.docker.compose.project=<name>`
and `dangling=false` - and keeps those whose `com.docker.compose.service` label names a service in
the project; `all` additionally takes `namedImages` (every `service.image` present locally).
`labeledLocalImages` is documented in-source as "images that were locally-built by a current
version of Compose", and its comment says the name "could either have been defined by the user or
implicitly created from the project + service name"
([`image_pruner.go`](https://github.com/docker/compose/blob/v5.5.1/pkg/compose/image_pruner.go)).
Local confirmation that our images carry exactly those labels: `chief-of-staff-demo-app` and
`chief-of-staff-demo-relay` both show `com.docker.compose.project=chief-of-staff-demo`,
`com.docker.compose.service=app|relay` and `com.docker.compose.version=5.5.1`. So for this repo,
`docker compose -p <run> down --rmi local` removes the run's locally built images - the canonical
names included, if that run rebuilt them - whereas bare `down` removes neither containers' images
nor the run's tag. One further v5.5.1 behavior the table folds into the `--rmi` rows: either mode
also removes the project's dangling images, through the same `removeDanglingImages` helper
`watch --prune` uses
([`down.go`](https://github.com/docker/compose/blob/v5.5.1/pkg/compose/down.go),
[`image_pruner.go`](https://github.com/docker/compose/blob/v5.5.1/pkg/compose/image_pruner.go)).

One caveat that follows from the labels: the project label is written by whichever build produced
the current image object, and on a local build that is Compose's own path (`getImageBuildLabels`
in [`build.go`](https://github.com/docker/compose/blob/v5.5.1/pkg/compose/build.go) adds
`ProjectLabel`, `ServiceLabel` and `VersionLabel`). An image built by buildx and merely `load`ed
(our CI path) never goes through that path and so carries no `com.docker.compose.project` label
for a later `down --rmi local` to find [INFERENCE for the CI path: `build-push-action` does not
know a Compose project, and that path was not run on this machine]. That is a feature in CI
(nothing to clean) and a surprise locally (a manually built image is not "Compose's" to remove).

### Anonymous volumes: the mechanism, and this machine's 36

The volumes page owns the behavior: "Docker can create a volume during container or service
creation"; "Anonymous volumes are given a random name that's guaranteed to be unique within a
given Docker host. Just like named volumes, anonymous volumes persist even if you remove the
container that uses them, except if you use the `--rm` flag when creating the container"; and "If
you create multiple containers consecutively that each use anonymous volumes, each container
creates its own volume. Anonymous volumes aren't reused or shared between containers
automatically" ([Volumes](https://docs.docker.com/engine/storage/volumes/)). Compose's `down`
reference adds that they are not removed by default, "as they don't have a stable name, they are
not automatically mounted by a subsequent `up`"
([compose down](https://docs.docker.com/reference/cli/docker/compose/down/)).

Local observation: `docker system df` reports **36 local volumes, 43.84 kB, 1 active, 100%
reclaimable**, and all 36 are anonymous (random 64-hex names, no named volumes). The running
searxng container's only volume mount is one of them; the searxng image declares
`Config.Volumes = {"/etc/searxng", "/var/cache/searxng"}` while `docker-compose.yml` maps only
`./searxng:/etc/searxng:Z`. The app image declares `/app/workspace` but that path is bind-mounted;
the relay and valkey images declare no volumes. So the set is best explained as one anonymous
volume per searxng container creation across the project's `up`/`down` history [INFERENCE for the
historical count; the mechanism and the current mount are observed]. The cost is trivial here
(kilobytes), but it is the only part of the container lifecycle that outlives `down`
without `-v`, and `docker volume prune -f` is precisely its documented cleaner.

## 3. Conventions real projects use

### 3.1 Pinned canonical names, one compose file, overrides for context

Compose itself documents the layering convention: "By default, Compose reads two files, a
`compose.yaml` and an optional `compose.override.yaml` file. By convention, the `compose.yaml`
contains your base configuration. The override file can contain configuration overrides for
existing services or entirely new services", with `-f`/`COMPOSE_FILE` for other names and the
merge rules spelled out per field ([Merge Compose files](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/)).

Evidence that shipping projects do this rather than cloning compose files:

- **supabase/supabase** keeps one base `docker/docker-compose.yml` and layers overrides through
  Compose's own `COMPOSE_FILE` list; `docker/run.sh` is the manager for it. The shipped default is
  `COMPOSE_FILE=docker-compose.yml` (`docker/.env.example`, which shows the layered
  `docker-compose.yml:docker-compose.pg17.yml` form as an example), and `run.sh config add|remove
  <name>` edits that list in `.env` while `run.sh config` prints it
  ([`docker/run.sh`](https://github.com/supabase/supabase/blob/master/docker/run.sh),
  [`docker/.env.example`](https://github.com/supabase/supabase/blob/master/docker/.env.example)).
- **immich-app/immich** wires its devcontainer to a *stack of files* rather than a copy:
  `"dockerComposeFile": ["../docker/docker-compose.dev.yml", "./server/container-compose-overrides.yml"]`
  with `"service": "immich-server"` and `runServices` for dependencies
  ([`.devcontainer/devcontainer.json`](https://github.com/immich-app/immich/blob/main/.devcontainer/devcontainer.json)).
- **PurpleAILAB/Decepticon** keeps `develop.watch` in a separate overlay so older Compose versions
  do not parse it, and documents the invocation in the file header:
  "Usage: `docker compose -f docker-compose.yml -f docker-compose.watch.yml watch` / or via make:
  `make dev`" ([`docker-compose.watch.yml`](https://github.com/PurpleAILAB/Decepticon/blob/main/docker-compose.watch.yml)).
  This is the same compositional idea applied to the watch loop.

And projects that run isolated stacks on one host keep the image name fixed while varying the
project: Compose's project-name page names the CI case directly ("set the project name to a unique
build number"), and the repo's own
[`docs/agents/verification.md`](../agents/verification.md) states the local rule: an isolated
stack "does not invent an image name: its Compose file keeps the `image: chief-of-staff-demo-app` /
`chief-of-staff-demo-relay` names that `docker-compose.yml` pins".
The sources agree on the ordering: vary project name, ports, mounts - never the image identity.
Concretely, in the inspected projects:

- **keploy/keploy** scopes its CI stack per job and names the reason in a comment: "# Job-scoped
  compose project name to avoid collisions with concurrent runs." followed by
  `export COMPOSE_PROJECT_NAME="echo-sql-${JOB_ID}"`, and clears stale state first with
  `docker compose down --remove-orphans -v 2>/dev/null || true`
  ([`golang-docker-macos.sh`](https://github.com/keploy/keploy/blob/main/.github/workflows/test_workflow_scripts/golang/echo_sql/golang-docker-macos.sh)).
- **getredash/redash** runs its Cypress harness against the same compose file under a different
  project: `docker compose -p cypress build` / `up -d` / `down`
  ([`cypress.js`](https://github.com/getredash/redash/blob/master/client/cypress/cypress.js));
  **hyperdxio/hyperdx** does the same from a Makefile target with a separate CI file:
  `docker compose -p $(HDX_CI_PROJECT) -f ./docker-compose.ci.yml down -v`
  ([`Makefile`](https://github.com/hyperdxio/hyperdx/blob/main/Makefile)).
- **openemr/openemr** names its benchmark stack `-p "${PROJECT_NAME}"` and tears it down in a bash
  `trap cleanup EXIT`: `docker compose -p "${PROJECT_NAME}" down --remove-orphans --volumes`
  ([`benchmark.sh`](https://github.com/openemr/openemr/blob/master/docker/container_benchmarking/benchmark.sh)).
- **getsentry/self-hosted** fixes its project name in the environment instead of the command line:
  `.env` line 1 is `COMPOSE_PROJECT_NAME=sentry-self-hosted`
  ([`.env`](https://github.com/getsentry/self-hosted/blob/master/.env)), a value its own merge test
  asserts ([`merge-env-file-test.sh`](https://github.com/getsentry/self-hosted/blob/master/_unit-test/merge-env-file-test.sh)).

The #423 harness is a compact example of both halves: it kept the canonical name for `relay`
(`image: chief-of-staff-demo-relay` with a `build:` context) but gave `app` a run-scoped tag,
`image: issue-423-journeys:local`, and it ran under its own Compose project, so when the run
ended the tag's owner was a run directory rather than the repo
([`tooling/compose.yml`](../../artifacts/person-profile-remediation/20260918T035740Z-issue-423-journeys/tooling/compose.yml)).

### 3.2 Wrapper commands: the documented interface is one command, not the recipe

Every project with a multi-service stack hides the primitives behind one entry point:

- **supabase** - `sh run.sh start|stop|restart|recreate|status|logs|pull|config|secrets`, most
  arms a single `exec docker compose ...` (e.g. `start|up) exec docker compose up -d --wait "$@"`;
  `config` and `secrets` are pure shell, and the no-arg `recreate` arm runs `down` then `up`), with
  a separate destructive `docker/reset.sh` whose compose call is
  `docker compose -f docker-compose.yml -f ./dev/docker-compose.dev.yml down -v --remove-orphans`
  ([`docker/run.sh`](https://github.com/supabase/supabase/blob/master/docker/run.sh),
  [`docker/reset.sh`](https://github.com/supabase/supabase/blob/master/docker/reset.sh)).
- **getsentry/self-hosted** - `install/dc-detect-version.sh` defines the whole vocabulary once:
  `dc="$dc_base $NO_ANSI --env-file ${_ENV}"` for `install.sh` (other scripts get
  `dc="$dc_base $NO_ANSI"`) and `dcb="$dc build $proxy_args"`; the documented
  stop path is `$dc down -t $STOP_TIMEOUT --rmi local --remove-orphans` on Docker (podman prunes
  dangling images instead) in `install/turn-things-off.sh`
  ([`install/turn-things-off.sh`](https://github.com/getsentry/self-hosted/blob/master/install/turn-things-off.sh)).
  Its CONTRIBUTING states the contract: "The install flow is driven by `./install.sh` ... When the
  install completes, the expected next step is `docker compose up -d --wait`"
  ([`CONTRIBUTING.md`](https://github.com/getsentry/self-hosted/blob/master/CONTRIBUTING.md)).
- **jupyter/docker-stacks** - a Makefile is the whole interface, self-documenting via `make help`:
  `cont-stop-all`, `cont-rm-all`, `cont-clean-all: cont-stop-all cont-rm-all`, `img-list`,
  `img-rm-dang` ("remove dangling images (tagged None)" - literally
  `$(CONTAINER_CLI) image prune $(IMAGE_PRUNE_FLAGS)`), `img-rm` (dangling + the project's images),
  plus `build/%`, `push/%`, `run-shell/%`
  ([`Makefile`](https://github.com/jupyter/docker-stacks/blob/main/Makefile)).
- **n8n-io/n8n** - root `package.json` exposes `build:docker`, `build:docker:clean`
  (`DOCKER_BUILD_NO_CACHE=true DOCKER_BUILD_BASE_IMAGE=true`, i.e. force rebuild) and `clean`;
  the public installer `docker/get-n8n.sh` wraps compose in one shell function
  (`compose() { docker compose -f "${N8N_DIR}/compose.yml" "$@"; }`) and prints the stop/start/
  uninstall commands, the last being `down -v && rm -rf` with `# DELETES all n8n data`
  ([`package.json`](https://github.com/n8n-io/n8n/blob/master/package.json),
  [`docker/get-n8n.sh`](https://github.com/n8n-io/n8n/blob/master/docker/get-n8n.sh)).
- **nextcloud/docker** - no wrapper at all; the README *is* the interface, and it is three
  commands: `docker compose up -d`; to update, `docker compose pull` then `docker compose up -d`;
  when building a derived image, `docker compose build --pull` then `docker compose up -d`
  ([`README.md`](https://github.com/nextcloud/docker/blob/master/README.md)).
- **docker/awesome-compose** - each sample README documents the minimal pair, "Deploy with docker
  compose" then `docker compose down` after the line "Stop and remove the container"
  ([`angular/README.md`](https://github.com/docker/awesome-compose/blob/master/angular/README.md)).

The pattern: one command to start (always with the wait/health flag), one to stop, one to rebuild,
one to reclaim - and the raw `docker` commands only inside the wrapper. Projects do *not* document
`docker image prune` as the user's job; they either clean up inside the wrapper (sentry) or expose
a purpose-named target (`img-rm-dang`).

### 3.3 Tag schemes

Docker's own best-practices page owns the trade-off: "Image tags are mutable, meaning a publisher
can update a tag to point to a new image ... you're not guaranteed to get the same for every
build", versus digest pinning, which "helps you avoid unexpected changes" but is "more tedious"
and "opting out of automated security fixes"
([Building best practices](https://docs.docker.com/build/building/best-practices/)).

Real schemes, in increasing strictness:

- **Playwright** publishes `vX.Y.Z[-<ubuntu>]` release tags and tells users to pin:
  "It is recommended to always pin your Docker image to a specific version if possible. If the
  Playwright version in your Docker image does not match the version in your project/tests,
  Playwright will be unable to locate browser executables."
  ([playwright.dev/docs/docker](https://playwright.dev/docs/docker)). This is the closest published
  analogue to our 4 GB image: one pinned version, one Ubuntu base, no floating tag.
- **immich-app/immich** uses `ghcr.io/immich-app/immich-server:${IMMICH_VERSION:-release}` in the
  compose file, documents `IMMICH_VERSION=v3` in `example.env` ("You can pin this to a specific
  version like \"v2.1.0\""), and its release script rewrites the docs/env major pins on each
  release ([`docker/docker-compose.yml`](https://github.com/immich-app/immich/blob/main/docker/docker-compose.yml),
  [`packages/scripts/src/commands/release.ts`](https://github.com/immich-app/immich/blob/main/packages/scripts/src/commands/release.ts)).
- **go-gitea/gitea** generates `latest`, `1`, `1.2`, `1.2.3` from a `v1.*` git tag with
  `docker/metadata-action` (three `type=semver` lines, for `{{version}}`, `{{major}}` and
  `{{major}}.{{minor}}`, with `latest` from the action's default flavor), takes the version from
  the Dockerfile's `ARG GITEA_VERSION` (the release workflow passes no build args; `git describe`
  over the bind-mounted `.git` supplies it), and documents the consumer channels (`:1`, `:1.27.3`,
  `:nightly`, `:1.x-nightly`) ([`release-tag-version.yml`](https://github.com/go-gitea/gitea/blob/main/.github/workflows/release-tag-version.yml),
  [`Dockerfile`](https://github.com/go-gitea/gitea/blob/main/Dockerfile),
  [docs.gitea.com](https://docs.gitea.com/installation/install-with-docker/)).
- **n8n-io/n8n** adds immutable references on top: `${version}-${sha}` tags "for immutable
  references" plus `${version}-${date}` for nightlies, with the bake file defaulting local builds
  to `IMAGE_TAG = "local"` - i.e. a **local-only tag for local-only images**
  ([`docker-tags.mjs`](https://github.com/n8n-io/n8n/blob/master/.github/scripts/docker/docker-tags.mjs),
  [`docker-bake.hcl`](https://github.com/n8n-io/n8n/blob/master/docker/docker-bake.hcl)).
- **supabase/supabase** pins every image in the compose file to an explicit version, including a
  date+sha for its own studio (`supabase/studio:2026.09.07-sha-7996410`), and keeps
  `docker/versions.md`, a newest-first changelog headed "Docker image version updates in
  docker-compose.yml" ([`docker/docker-compose.yml`](https://github.com/supabase/supabase/blob/master/docker/docker-compose.yml),
  [`docker/versions.md`](https://github.com/supabase/supabase/blob/master/docker/versions.md)).

Two lessons that transfer: a local build tag (n8n's `local`, immich's `release` default) is a
deliberate namespace, not a leftover; and when the runtime is version-coupled (Playwright,
immich server), the docs say "pin", not "clean up after".

### 3.4 The dev loop: `develop.watch` and devcontainers

The Compose spec defines `develop.watch` as a list of `path` + `action` rules, with `rebuild`
documented as "Compose rebuilds the service image based on the `build` section and recreates the
service with the updated image" ([develop reference](https://docs.docker.com/reference/compose-file/develop/) -
available with Compose 2.22+). The how-to adds the two boundaries that matter operationally:
watch "is designed to work with services built from local source code using the `build` attribute.
It doesn't track changes for services that rely on pre-built images specified by the `image`
attribute", and the default prune behavior for superseded images quoted in 1.1
([Use Compose Watch](https://docs.docker.com/compose/how-tos/file-watch/)).

Evidence of use: **suitenumerique/meet** puts `develop: watch: - action: rebuild` on its dev
services ([`compose.yml`](https://github.com/suitenumerique/meet/blob/main/compose.yml));
**Decepticon** keeps the rules in `docker-compose.watch.yml` behind `make dev` (3.1); our own
`docker-compose.yml` uses `action: rebuild` for the app only. For the devcontainer shape,
microsoft/vscode-dev-containers' archived compose template pairs `dockerComposeFile`, `service`
and `workspaceFolder`
([`docker-existing-docker-compose/devcontainer.json`](https://github.com/microsoft/vscode-dev-containers/blob/main/containers/docker-existing-docker-compose/.devcontainer/devcontainer.json)),
and immich ships the live equivalent (3.1); the point in both is the same: the dev environment is
declared as compose files, not re-created by hand.

### 3.5 CI practice

- **Ephemeral machines.** "With the exception of single-CPU runners, each GitHub-hosted runner is
  a new virtual machine (VM) hosted by GitHub"
  ([GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)).
  Nothing on the runner survives the job, so CI cleanup is only about the job's own exit path.
- **Cache scopes.** Docker's `gha` backend is "the recommended cache to use inside your GitHub
  Actions workflows", and it is pip-instance-scoped: "Scope is a key used to identify the cache
  object. By default, it is set to `buildkit`. If you build multiple images, each build will
  overwrite the cache of the previous, leaving only the final cache"
  ([GitHub Actions cache](https://docs.docker.com/build/cache/backends/gha/)). Per-image
  `scope=` values are therefore the documented way to keep several images cached (our `ci.yml`
  passes `scope=app` and `scope=relay`, one per build step). `mode=max` is what exports
  intermediate-stage cache; the inline exporter "only supports `min` cache mode"
  ([Cache management with GitHub Actions](https://docs.docker.com/build/ci/github-actions/cache/)).
  Write access is not guaranteed: cache exports fail for read-only triggers, and the docs'
  remedy is to keep `cache-from` and drop `cache-to` there (same page).
- **Real workflows.** **cal.com** (`calcom/cal.diy`) builds its test image with `load: true,
  push: false`, re-runs the same build with `push: true` only when the caller asked for a push and
  the event is not a release prerelease
  (`if: ${{ inputs.push-image == 'true' && !github.event.release.prerelease }}`), and ends the
  composite action with a `Cleanup` step running `docker compose down` under `if: always()` - the
  same shape
  as our `image` job
  ([`docker-build-and-test/action.yml`](https://github.com/calcom/cal.diy/blob/main/.github/actions/docker-build-and-test/action.yml)).
  **supabase** exports `cache-from: type=gha` / `cache-to: type=gha,mode=max` for its single heavy
  studio image and selects `target: production`
  ([`publish_image.yml`](https://github.com/supabase/supabase/blob/master/.github/workflows/publish_image.yml)).
  **immich** keeps an unconditional `if: always()` "Capture Docker logs" step after bringing its
  e2e stack up (`docker compose logs --no-color > docker-compose-logs.txt`) and tears the stack
  down from the test helper
  ([`test.yml`](https://github.com/immich-app/immich/blob/main/.github/workflows/test.yml),
  [`e2e/src/docker-compose.ts`](https://github.com/immich-app/immich/blob/main/e2e/src/docker-compose.ts)).
- **`load: true`.** In `docker/build-push-action`, `load` is documented as "Load is a shorthand
  for --output=type=docker"; the docs' export example is exactly the shape our `image` job uses:
  build with `load: true`, then use the image in a later step
  ([`action.yml`](https://github.com/docker/build-push-action/blob/master/action.yml),
  [Export to Docker with GitHub Actions](https://docs.docker.com/build/ci/github-actions/export-docker/)).
  The provenance input is the same action's `--attest=type=provenance` shorthand; note the default
  attestation behavior from 1.6 applies to whatever the runner's store supports.
- **Cleanup on the way out.** `if: always()` is documented as "Causes the step to always execute,
  and returns `true`, even when canceled" - but GitHub then documents the better tool: "Avoid
  using `always` for any task that could suffer from a critical failure ... use the recommended
  alternative: `if: ${{ !cancelled() }}`" ([Evaluate expressions](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions)).
  For a `docker compose down` teardown, `!cancelled()` expresses the intent exactly: run on
  success and on failure, skip on cancellation.
- **What the inspected workflows don't do.** None of the build workflows read for this note
  (supabase, immich, gitea, n8n, cal.com) uses `docker image prune`, `docker system prune`, or
  `docker builder prune` as a teardown step; the unconditional steps are `docker compose down`
  (cal.com) and log capture (immich). On a fresh VM, `down` is the whole cleanup story - there is
  no accumulated residue for prune to find.

## 4. Making the flow legible in documentation

The sources and projects agree on four elements: a one-command quickstart, an explicit
stop/cleanup step, a stated runtime/version, and example output.

- **docker/awesome-compose** keeps every sample to the same skeleton: prerequisites, a "## Deploy
  with docker compose" heading with `docker compose up -d`, expected container listing, then the
  unheaded line "Stop and remove the container" followed by `docker compose down`
  ([`angular/README.md`](https://github.com/docker/awesome-compose/blob/master/angular/README.md)).
- **nextcloud/docker** states the runtime assumption inside the command's sentence: "Then run
  `docker compose up -d`, now you can access Nextcloud at http://localhost:8080/ from your host
  system", and gives the update path as two commands with the reason next to them ("The `--pull`
  option tells docker to look for new versions of the base image")
  ([`README.md`](https://github.com/nextcloud/docker/blob/master/README.md)).
- **getsentry/self-hosted** states the process contract in CONTRIBUTING (quoted in 3.2) and names
  the cleanup script's behavior in its own header (`turn-things-off.sh`); the user is told what
  will run, not just how to invoke it.
- **jupyter/docker-stacks** makes the Makefile self-describing (`make help` prints every target's
  `##` comment) so "Rebuild a stack" is `make build/minimal-notebook`, not a buildx invocation
  ([`Makefile`](https://github.com/jupyter/docker-stacks/blob/main/Makefile)).
- **Playwright** owns the runtime claim in one page: pull, run, the recommended flags
  (`--init` "recommended to avoid special treatment for processes with PID=1"; `--ipc=host`
  "recommended when using Chromium"), the tag list, and the pinning warning
  ([playwright.dev/docs/docker](https://playwright.dev/docs/docker)).

The anti-pattern the same evidence shows: a cleanup step that exists only in a contributor's
memory. Every hygiene command in these projects is either inside a named wrapper or on a
documented page - there is no project that documents `up` and leaves `down --rmi` unmentioned.

## What this suggests for this repo

The repo already matches most of the strong conventions: canonical `image:` names with `build:`
in `docker-compose.yml` (both built services), loopback-only ports (ADR-0001), `develop.watch`
for the code loop, a documented container gate in `docs/agents/verification.md`, and CI that
builds with scoped `type=gha` caches, loads its images, runs `up -d --no-build` and tears down
under a guaranteed status check. The sources point at a short list of things to keep in step:

1. **Keep the isolated-run teardown `down --rmi local`, and keep saying so where the run is
   documented.** `docs/agents/verification.md` already states the rule - "Bring the isolated
   project down with `docker compose -p <name> down --rmi local`" - and explains it: the v5.5.1
   pruner removes images carrying that project's Compose labels, a run-specific tag like #423's
   included, where `docker image prune -f` cannot reach a tagged image; pulled images (searxng,
   valkey) carry no project label and survive. Two details there are worth re-checking against
   today's measurements. Its side-effect clause - if the run rebuilt the canonical names, `local`
   takes those too and the next `up --build` rebuilds them - matches the pruner sources. But
   "`docker image prune -f` clears the dangling image each app rebuild leaves" did not reproduce
   here: under the containerd store the two unchanged rebuilds above left no dangling image at
   all (1.1, 1.6).
2. **Keep the "no invented image name" rule and, where possible, don't rebuild in isolated
   runs.** The existing rule in `docs/agents/verification.md` is exactly what the conventions
   above converge on; the CI job already models the stronger form (`build` once, then
   `up -d --no-build`). An isolated acceptance run that only *reuses* the canonical image cannot
   move a tag or orphan an image at all.
3. **Map searxng's cache to a named volume (or accept `docker volume prune -f`).** The 36
   anonymous volumes all trace to the image-declared `/var/cache/searxng` mount that our compose
   file does not map; nothing else in the stack declares a volume. A named
   `searxng-cache:/var/cache/searxng` in `docker-compose.yml` makes the data explicit, keeps
   `down -v` meaningful, and stops the count growing per container recreation. If the mapping is
   deliberately left out (the cache is disposable), then `docker volume prune -f` - which removes
   only unused anonymous volumes - is the matching one-liner, as verification.md already notes.
4. **Keep cache pruning bounded and deliberate.** 25.9 GB of build cache (21.47 GB reclaimable)
   against 4.88 GB of images is the real local cost, and the thing that keeps the loop at ~30 s.
   If disk pressure ever forces a trim, `docker buildx prune --filter "until=168h"` (or
   `--max-used-space`) follows the documented semantics; the bare `docker buildx prune` empties
   the builder and pays the full rebuild next time. `docker system prune` is the wrong tool for
   cache pressure: it also removes stopped containers and dangling images, and `-a` is the flag
   that would recreate the #423 problem by removing every image no container is currently using.
5. **In CI, prefer the documented status function.** The `image` job's teardown step uses
   `if: always()`; GitHub now documents `if: ${{ !cancelled() }}` as "the recommended
   alternative" for steps that should run regardless of success or failure. It is a one-line
   change with identical behavior for this job (run after failure, skip after cancellation).
   Separately, do not add any check that compares `docker image ls` IDs across builds: on the
   containerd image store those are attested-index digests and churn by design (1.6).

Everything else - service names, tag scheme (`:latest` on the canonical names is the local-dev
convention; the CI job is the only producer of runnable images), watch scope, port bindings -
needs no change. The one documentation gap is discoverability: the cleanup vocabulary lives in
`docs/agents/verification.md`, while the README's Docker story stops at `docker compose down`.
The lightest fix consistent with the examples in section 4 is a two-line "Cleaning up" pointer in
the README to that section, not a second set of commands.

## Not verified from a primary source

- The classic-store row of the rebuild-identity table (1.6): this machine only has the containerd
  store, so "same image ID, and nothing re-stamps `Created`" rests on #13636's reporter, not on a
  build performed here. Also unobservable now: whether a *content-changing* rebuild leaves a
  superseded image dangling on c8d, or drops it the way the unchanged rebuilds above were
  dropped.
- Whether a `docker build-push-action` `load: true` build on GitHub's `ubuntu-latest` receives
  default provenance (it depends on the runner's image store; the docs say attestations need an
  index-capable store and that `--load` keeps the same requirement, without saying which store the
  runner has). Nothing in the repo currently depends on this.
- Whether plain `docker compose build` (not watch) prunes superseded images in any version: the
  docs document that only for watch. The v5.5.1 sources share the dangling-image removal between
  `down --rmi` and `watch --prune` (2), and neither build above left a dangling image to test -
  under c8d the superseded index is dropped outside Compose (1.1). The run-specific
  `issue-423-journeys:local` tag has since been removed; only the four canonical images remain.
  What the note still does not claim is which command did that.

## Sources

1. [Prune unused Docker objects](https://docs.docker.com/engine/manage-resources/pruning/);
   [docker image prune](https://docs.docker.com/reference/cli/docker/image/prune/);
   [docker volume prune](https://docs.docker.com/reference/cli/docker/volume/prune/);
   [docker system prune](https://docs.docker.com/reference/cli/docker/system/prune/);
   [docker buildx prune](https://docs.docker.com/reference/cli/docker/buildx/prune/);
   [Build cache garbage collection](https://docs.docker.com/build/cache/garbage-collection/).
2. [docker compose down](https://docs.docker.com/reference/cli/docker/compose/down/);
   [docker compose build](https://docs.docker.com/reference/cli/docker/compose/build/);
   [docker compose run](https://docs.docker.com/reference/cli/docker/compose/run/);
   [docker compose watch](https://docs.docker.com/reference/cli/docker/compose/watch/);
   [Use Compose Watch](https://docs.docker.com/compose/how-tos/file-watch/);
   [Merge Compose files](https://docs.docker.com/compose/how-tos/multiple-compose-files/merge/);
   [Specify a project name](https://docs.docker.com/compose/how-tos/project-name/);
   [develop reference](https://docs.docker.com/reference/compose-file/develop/).
3. [Multi-stage builds](https://docs.docker.com/build/building/multi-stage/);
   [Building best practices](https://docs.docker.com/build/building/best-practices/);
   [Build attestations](https://docs.docker.com/build/metadata/attestations/);
   [Volumes](https://docs.docker.com/engine/storage/volumes/).
4. docker/compose: [`pkg/compose/down.go`](https://github.com/docker/compose/blob/v5.5.1/pkg/compose/down.go),
   [`pkg/compose/image_pruner.go`](https://github.com/docker/compose/blob/v5.5.1/pkg/compose/image_pruner.go),
   [`pkg/compose/images.go`](https://github.com/docker/compose/blob/v5.5.1/pkg/compose/images.go) and
   [`pkg/compose/build.go`](https://github.com/docker/compose/blob/v5.5.1/pkg/compose/build.go) at
   tag `v5.5.1`; [issue #13636](https://github.com/docker/compose/issues/13636);
   [PR #13949](https://github.com/docker/compose/pull/13949); [PR #14112](https://github.com/docker/compose/pull/14112);
   [moby/buildkit#3552](https://github.com/moby/buildkit/issues/3552).
5. [GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners);
   [Evaluate expressions](https://docs.github.com/en/actions/reference/workflows-and-actions/expressions);
   [GitHub Actions cache backend](https://docs.docker.com/build/cache/backends/gha/);
   [Cache management with GitHub Actions](https://docs.docker.com/build/ci/github-actions/cache/);
   [Export to Docker with GitHub Actions](https://docs.docker.com/build/ci/github-actions/export-docker/);
   [build-push-action `action.yml`](https://github.com/docker/build-push-action/blob/master/action.yml).
6. Project files: [supabase `docker/run.sh`](https://github.com/supabase/supabase/blob/master/docker/run.sh)
   and [`docker/.env.example`](https://github.com/supabase/supabase/blob/master/docker/.env.example);
   [getsentry `install/turn-things-off.sh`](https://github.com/getsentry/self-hosted/blob/master/install/turn-things-off.sh);
   [jupyter/docker-stacks `Makefile`](https://github.com/jupyter/docker-stacks/blob/main/Makefile);
   [n8n `package.json`](https://github.com/n8n-io/n8n/blob/master/package.json) and
   [`docker/get-n8n.sh`](https://github.com/n8n-io/n8n/blob/master/docker/get-n8n.sh);
   [nextcloud/docker `README.md`](https://github.com/nextcloud/docker/blob/master/README.md);
   [immich `.devcontainer/devcontainer.json`](https://github.com/immich-app/immich/blob/main/.devcontainer/devcontainer.json)
   and [`docker/example.env`](https://github.com/immich-app/immich/blob/main/docker/example.env);
   [gitea `release-tag-version.yml`](https://github.com/go-gitea/gitea/blob/main/.github/workflows/release-tag-version.yml)
   and [`Dockerfile`](https://github.com/go-gitea/gitea/blob/main/Dockerfile);
   [awesome-compose `angular/README.md`](https://github.com/docker/awesome-compose/blob/master/angular/README.md);
   [supabase `publish_image.yml`](https://github.com/supabase/supabase/blob/master/.github/workflows/publish_image.yml);
   [cal.com `docker-build-and-test/action.yml`](https://github.com/calcom/cal.diy/blob/main/.github/actions/docker-build-and-test/action.yml);
   [immich `test.yml`](https://github.com/immich-app/immich/blob/main/.github/workflows/test.yml) and
   [`e2e/src/docker-compose.ts`](https://github.com/immich-app/immich/blob/main/e2e/src/docker-compose.ts);
   [keploy `golang-docker-macos.sh`](https://github.com/keploy/keploy/blob/main/.github/workflows/test_workflow_scripts/golang/echo_sql/golang-docker-macos.sh);
   [redash `cypress.js`](https://github.com/getredash/redash/blob/master/client/cypress/cypress.js);
   [openemr `benchmark.sh`](https://github.com/openemr/openemr/blob/master/docker/container_benchmarking/benchmark.sh);
   [hyperdx `Makefile`](https://github.com/hyperdxio/hyperdx/blob/main/Makefile);
   [sentry `.env`](https://github.com/getsentry/self-hosted/blob/master/.env);
   [Decepticon `docker-compose.watch.yml`](https://github.com/PurpleAILAB/Decepticon/blob/main/docker-compose.watch.yml);
   [meet `compose.yml`](https://github.com/suitenumerique/meet/blob/main/compose.yml);
   [vscode-dev-containers `docker-existing-docker-compose`](https://github.com/microsoft/vscode-dev-containers/blob/main/containers/docker-existing-docker-compose/.devcontainer/devcontainer.json);
   [playwright.dev/docs/docker](https://playwright.dev/docs/docker).
7. Local observations (2026-09-18, this workstation). Read-only: `docker compose version --short`
   -> `5.5.1`; `docker image ls` -> four images (app 4.06 GB, relay 372 MB, searxng 370 MB,
   valkey 75 MB); `docker image inspect chief-of-staff-demo-app` -> ID = `.Descriptor.digest` with
   `mediaType=application/vnd.oci.image.index.v1+json`; image labels
   `com.docker.compose.project=chief-of-staff-demo` / `.service=app|relay` / `.version=5.5.1`;
   `docker system df` -> images 4.879 GB (0% reclaimable), local volumes 36 / 43.84 kB (100%
   reclaimable), build cache 25.9 GB (21.47 GB reclaimable); `docker ps --format '{{.Mounts}}'`
   shows searxng attached to exactly one anonymous volume; declared volumes: app `/app/workspace`
   (`Dockerfile`), searxng `/etc/searxng` + `/var/cache/searxng`, relay and valkey none; repo
   files cited inline (`docker-compose.yml`, `Dockerfile`, `relay/Dockerfile`,
   `.github/workflows/ci.yml`, `docs/agents/verification.md`, `README.md`). State-changing (the
   only such commands run for this note): `docker compose build app` twice, with `docker image
   inspect` before and after each (1.6); `docker image inspect` of the superseded IDs -> `No such
   image`; `docker image inspect chief-of-staff-demo-relay:latest` -> `sha256:acb49b27fb9e...`,
   `Created` `2026-09-14T16:40:40.070532094Z`, while `chief-of-staff-demo-relay-1` reports
   `sha256:61ada657d954...` and that image no longer inspects (1.6).
