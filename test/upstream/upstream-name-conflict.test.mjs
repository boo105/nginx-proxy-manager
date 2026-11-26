import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

// A name already held by another host has to be refused before anything is written. The image
// runs the backend with --abort_on_uncaught_exception, so the UNIQUE error SQLite would throw on
// the write takes the whole process down instead of reaching handleUpstreamNameConflict.

const loadService = async (t) => {
	// Import the real service without reading or creating deployment credentials.
	const exists = fs.existsSync;
	const read = fs.readFileSync;
	t.mock.method(fs, "existsSync", (file) => file === "/data/keys.json" || exists(file));
	t.mock.method(fs, "readFileSync", (file, ...args) =>
		file === "/data/keys.json" ? '{"key":"test","pub":"test"}' : read(file, ...args),
	);
	const { default: service } = await import("../../backend/internal/proxy-host.js");
	const { default: model } = await import("../../backend/models/proxy_host.js");
	const { default: host } = await import("../../backend/internal/host.js");
	const { default: db } = await import("../../backend/db.js");
	t.after(() => db().destroy());
	return { service, model, host };
};

const access = {
	can: async () => ({ permission_visibility: "all" }),
	token: { getUserId: () => 1 },
};

// Stands in for the proxy_host table: rows holding a name, and every write that reached it.
const mockTable = (t, model, takenBy) => {
	const writes = [];
	const lookups = [];
	t.mock.method(model, "query", () => {
		const lookup = { name: null, excludedId: null };
		return {
			select() {
				return this;
			},
			where(column, value) {
				if (column === "upstream_name") {
					lookup.name = value;
				}
				return this;
			},
			whereNot(column, value) {
				if (column === "id") {
					lookup.excludedId = value;
				}
				return this;
			},
			async first() {
				lookups.push({ ...lookup });
				const id = takenBy[lookup.name];
				return id && id !== lookup.excludedId ? { id } : undefined;
			},
			async insertAndFetch(data) {
				writes.push(["insert", data]);
				return { id: 99, ...data };
			},
			async patch(data) {
				writes.push(["patch", data]);
				return 1;
			},
		};
	});
	return { writes, lookups };
};

test("creating a host with a taken upstream name is refused before the insert", async (t) => {
	const { service, model, host } = await loadService(t);
	t.mock.method(host, "isHostnameTaken", async () => ({ is_taken: false }));
	t.mock.method(host, "cleanSslHstsData", (data) => data);
	const { writes } = mockTable(t, model, { shared_pool: 1 });

	await assert.rejects(
		service.create(access, {
			domain_names: ["second.internal"],
			forward_scheme: "http",
			forward_host: "127.0.0.1",
			forward_port: 8080,
			// A different spelling of the same name: names are compared after normalization
			upstream_name: "Shared_Pool",
			upstream_servers: [{ host: "127.0.0.1", port: 8080 }],
			forwarding_mode: "upstream",
		}),
		{ status: 400, message: "Upstream name is already in use" },
	);
	assert.deepEqual(writes, []);
});

test("renaming a host to a taken upstream name is refused before the patch", async (t) => {
	const { service, model, host } = await loadService(t);
	t.mock.method(host, "cleanSslHstsData", (data) => data);
	t.mock.method(service, "get", async () => ({
		id: 2,
		enabled: true,
		domain_names: ["second.internal"],
		upstream_name: "own_pool",
		lb_method: "round_robin",
		forwarding_mode: "upstream",
		upstream_servers: [{ host: "127.0.0.1", port: 8080 }],
		certificate_id: 0,
		meta: {},
	}));
	const { writes, lookups } = mockTable(t, model, { shared_pool: 1, own_pool: 2 });

	await assert.rejects(service.update(access, { id: 2, upstream_name: "shared_pool" }), {
		status: 400,
		message: "Upstream name is already in use",
	});
	assert.deepEqual(writes, []);
	assert.deepEqual(lookups, [{ name: "shared_pool", excludedId: 2 }]);
});

test("a host may keep or re-save its own upstream name", async (t) => {
	const { service, model } = await loadService(t);
	const { lookups } = mockTable(t, model, { own_pool: 2 });

	await service.assertUpstreamNameAvailable("own_pool", 2);
	await service.assertUpstreamNameAvailable(null);
	assert.deepEqual(lookups, [{ name: "own_pool", excludedId: 2 }]);
});
