// Loaded before every plugin test file (each workspace's test script passes
// --import). A developer machine with local memory on has a device route,
// and agent-sdk would send the tests' requests to that machine's gateway
// instead of the test server. agent-sdk's device-route tests set their own
// EVERME_MEMORY_HOME for each case.
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.EVERME_MEMORY_HOME = join(tmpdir(), "everme-plugin-tests-no-device-route");
