# Teardown execution evidence

Baseline: `92f473f3e874a449ccce388ee8ef2237b29234e2`. All probe data is synthetic.
Summaries below are extracted from actual command logs, not generated expected outputs.
Raw local logs remain under `.scratch/teardown-2026-10-08/`.

## E01 baseline whole-tree gate

```text
 Test Files  297 passed (297)
      Tests  3593 passed (3593)
   Duration  65.73s (tests 54%, import 37%, transform 6%, environment 3%)
```

## E02 failing request/filter regressions

```text
⎯⎯⎯⎯⎯⎯ Failed Tests 19 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  2 failed (2)
      Tests  19 failed | 57 passed (76)
   Duration  6.45s (import 48%, transform 36%, tests 16%)
```

## E03 failing overlap regression

```text
Error: expect(locator).toContainText(expected) failed

    Locator: getByRole('alert')
    Expected substring: "changed since you read it"
    Timeout: 10000ms
    Error: element(s) not found
  1 failed
```

## E04 green overlap regression before group holdout

```text
  1 passed (6.0s)
```

## E05 installation negative probe

```text
npm error code EUNSUPPORTEDPROTOCOL
npm error Unsupported URL Type "workspace:": workspace:*
```

## E06 missing OAuth state regressions

```text
⎯⎯⎯⎯⎯⎯⎯ Failed Tests 8 ⎯⎯⎯⎯⎯⎯⎯
 Test Files  1 failed (1)
      Tests  8 failed | 6 passed (14)
   Duration  2.63s (import 61%, transform 29%, tests 10%)
```

## E07 OAuth/HTTP compatibility regressions

```text
 Test Files  3 passed (3)
      Tests  39 passed (39)
   Duration  4.35s (import 55%, transform 34%, tests 11%)
```

## E08 group-move holdout

```text
Error: expect(locator).toHaveValue(expected) failed

    Locator: locator('#task-task_20261008091132184_624ec966').getByLabel('Title', { exact: true })
    Expected: "Concurrent edit probe"
    Timeout: 10000ms
    Error: element(s) not found
  1 failed
```

## E09 re-attack before the second fix

```text
Expected: "/settings?google=state_mismatch"
Received: "/settings?google=connected"
- 403
+ 200
 Test Files  2 failed (2)
      Tests  4 failed | 31 passed (35)
   Duration  5.56s (import 59%, transform 31%, tests 10%)
```

## E10 green discriminating holdouts

```text
 Test Files  2 passed (2)
      Tests  35 passed (35)
   Duration  4.83s (import 60%, transform 28%, tests 11%)
```

## E11 current whole-tree gate

```text
 Test Files  298 passed (298)
      Tests  3625 passed (3625)
   Duration  73.57s (tests 52%, import 38%, transform 8%, environment 2%)
```

## E12 current browser suite

```text
  ✓    6 [chromium] › e2e/local-request-boundary.spec.ts:5:1 › another local website cannot submit a bodyless Task action (3.1s)
  ✓    8 [chromium] › e2e/local-request-boundary.spec.ts:38:1 › an uninitiated Google callback gives a reconnect path (312ms)
  ✓  106 [chromium] › e2e/task-concurrent-edit.spec.ts:4:3 › a stale Task form preserves work and recovers (group move: false) (3.8s)
  ✓  108 [chromium] › e2e/task-concurrent-edit.spec.ts:4:3 › a stale Task form preserves work and recovers (group move: true) (1.6s)
  142 passed (2.6m)
```

## E13 final production replay and restart

```text
Refused mutation; identical Task: {'Origin': 'https://attacker.invalid'}
Refused mutation; identical Task: {'Origin': 'http://127.0.0.1:4399'}
Refused mutation; identical Task: {'Sec-Fetch-Site': 'same-site'}
Refused mutation; identical Task: {'Sec-Fetch-Site': 'cross-site'}
Refused hostile Host with explicit body: {"error":"untrusted-host","message":"Open this local app using localhost or its loopback address."}
Repeated filter: 400 {"error":"invalid-task-filter","message":"The search filter must be supplied once as text."}
Stale update refused: 409 {"error":"task-version-conflict","message":"That Task changed since you read it (expected version 1, current 2). Reload it and review the change."}
Encoded/case path API-data control: /api%2ftasks 200
Encoded/case path API-data control: /%61pi/tasks 403
Encoded/case path API-data control: /API/tasks 200
Encoded/case path API-data control: //api/tasks 200
Production HTML, JS asset, health, normal capture and versioned edit verified.
Restart health {ok:true}; identical Task id/title/notes/status/version after restart.
No listed provider credentials inherited by isolated container.
Image: sha256:62d8abd5186f0900f80725211094814ae7f71ab6c93246fb08290bbcd3e5e564
```

The uppercase, doubled-slash and encoded-slash controls return the SPA HTML, not API data.
The encoded letters that Fastify matches to API routes now return 403. Initial replay before
server readiness saw a closed connection; rerun after the listening log succeeded.
