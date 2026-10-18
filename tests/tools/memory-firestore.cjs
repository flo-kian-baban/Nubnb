// An in-memory Firestore and Storage for tests that run the app's own server functions (the Costs page, round 1):
// every read and write method the app uses is answered from memory, so nothing is read from or written to Firestore
// or Storage, and every outgoing connection is refused first. Reads are counted as Firestore bills them (a document
// read is one; a query one per document returned, at least one) in globalThis.__memReads. Documents are put in with
// globalThis.__memSeed(collection, id, data) and read back with globalThis.__memDoc(collection, id).
// Loaded with createRequire from the test, before any app module; the test gives firebase-admin a made-up account.
const net = require('net');
const tls = require('tls');
const refuse = (what) => () => { throw new Error(`NO NETWORK in tests: ${what} refused`); };
net.connect = net.createConnection = refuse('net.connect');
net.Socket.prototype.connect = refuse('socket.connect');
tls.connect = refuse('tls.connect');
for (const m of ['http', 'https', 'http2']) { const mod = require(m); mod.request = refuse(`${m}.request`); mod.get = refuse(`${m}.get`); if (mod.connect) mod.connect = refuse(`${m}.connect`); }
globalThis.fetch = async () => { throw new Error('NO NETWORK in tests: fetch refused'); };
const path = require('path');
const { Writable } = require('stream');
const root = path.resolve(__dirname, '..', '..');
const load = (m) => require(require.resolve(m, { paths: [root] }));
const firestore = load('@google-cloud/firestore');
const { Timestamp, FieldPath, DocumentReference, Query, Firestore, WriteBatch, CollectionReference } = firestore;
globalThis.__memReads = [];
const count = (via, what, billed) => globalThis.__memReads.push({ via, what, billed });
const log = () => {};

// ── The store: collection → id → { data, createTime } ──
const store = new Map();
const coll = (name) => store.get(name) ?? store.set(name, new Map()).get(name);
globalThis.__memSeed = (collection, id, data) => coll(collection).set(id, { data, createTime: Timestamp.now() });

const clone = (value) => {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Timestamp || value instanceof DocumentReference || Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
};
const segmentsOf = (field) => (field instanceof FieldPath ? field.segments ?? field.toString().split('.') : String(field).split('.'));
const getPath = (data, field) => segmentsOf(field).reduce((v, k) => (v && typeof v === 'object' ? v[k] : undefined), data);
const fieldName = (field) => (field instanceof FieldPath ? field.formattedName ?? field.toString() : String(field));

function snapshot(ref, entry) {
  const exists = !!entry;
  return {
    id: ref.id,
    ref,
    exists,
    createTime: entry?.createTime ?? undefined,
    updateTime: exists ? Timestamp.now() : undefined,
    readTime: Timestamp.now(),
    data: () => (exists ? clone(entry.data) : undefined),
    get: (field) => (exists ? clone(getPath(entry.data, field)) : undefined),
    isEqual: () => false,
  };
}
const collName = (ref) => ref.path.split('/').slice(0, -1).join('/');
const lookup = (ref) => coll(collName(ref)).get(ref.id);

// ── Comparing as Firestore does, enough for this app: numbers, strings, booleans, null, references by path ──
const key = (v) => (v instanceof DocumentReference ? v.id : v instanceof Timestamp ? v.toMillis() : v);
const cmp = (a, b) => {
  const x = key(a);
  const y = key(b);
  if (x === y) return 0;
  if (x === undefined || x === null) return -1;
  if (y === undefined || y === null) return 1;
  return x < y ? -1 : 1;
};
function matches(filter, id, data) {
  if (Array.isArray(filter.filters)) {
    const parts = filter.filters.map((f) => matches(f, id, data));
    return filter.operator === 'OR' ? parts.some(Boolean) : parts.every(Boolean);
  }
  const name = fieldName(filter.field);
  const actual = name === '__name__' ? id : getPath(data, filter.field);
  const want = filter.value;
  switch (filter.op) {
    case 'EQUAL':
      return cmp(actual, want) === 0;
    case 'NOT_EQUAL':
      return actual !== undefined && cmp(actual, want) !== 0;
    case 'LESS_THAN':
      return actual !== undefined && cmp(actual, want) < 0;
    case 'LESS_THAN_OR_EQUAL':
      return actual !== undefined && cmp(actual, want) <= 0;
    case 'GREATER_THAN':
      return actual !== undefined && cmp(actual, want) > 0;
    case 'GREATER_THAN_OR_EQUAL':
      return actual !== undefined && cmp(actual, want) >= 0;
    case 'IN':
      return want.some((w) => cmp(actual, w) === 0);
    case 'NOT_IN':
      return actual !== undefined && !want.some((w) => cmp(actual, w) === 0);
    case 'ARRAY_CONTAINS':
      return Array.isArray(actual) && actual.some((a) => cmp(a, want) === 0);
    case 'ARRAY_CONTAINS_ANY':
      return Array.isArray(actual) && actual.some((a) => want.some((w) => cmp(a, w) === 0));
    default:
      throw new Error(`MEM: filter ${filter.op} not answered`);
  }
}
function runQuery(query) {
  const o = query._queryOptions;
  const parent = o.parentPath && o.parentPath.segments && o.parentPath.segments.length > 0 ? `${o.parentPath.segments.join('/')}/` : '';
  const name = `${parent}${o.collectionId}`;
  let rows = [...coll(name).entries()].map(([id, entry]) => ({ id, entry }));
  for (const f of o.filters ?? []) rows = rows.filter((r) => matches(f, r.id, r.entry.data));
  const orders = o.fieldOrders ?? [];
  if (orders.length > 0) {
    rows.sort((a, b) => {
      for (const order of orders) {
        const n = fieldName(order.field);
        const c = n === '__name__' ? cmp(a.id, b.id) : cmp(getPath(a.entry.data, order.field), getPath(b.entry.data, order.field));
        if (c !== 0) return order.direction === 'DESCENDING' ? -c : c;
      }
      return 0;
    });
  }
  if (o.offset) rows = rows.slice(o.offset);
  if (typeof o.limit === 'number') rows = o.limitType === 1 ? rows.slice(-o.limit) : rows.slice(0, o.limit);
  const db = query.firestore ?? query._firestore;
  const docs = rows.map((r) => snapshot(db.doc(`${name}/${r.id}`), r.entry));
  return { docs, size: docs.length, empty: docs.length === 0, query, readTime: Timestamp.now(), forEach: (fn) => docs.forEach(fn), docChanges: () => [], isEqual: () => false };
}

// ── Writes, applied as Firestore applies them ──
const isTransform = (v) => v !== null && typeof v === 'object' && typeof v.methodName === 'string' && v.methodName.startsWith('FieldValue.');
function setPath(target, segments, value) {
  let at = target;
  for (const s of segments.slice(0, -1)) at = at[s] && typeof at[s] === 'object' && !Array.isArray(at[s]) ? at[s] : (at[s] = {});
  const last = segments[segments.length - 1];
  if (isTransform(value)) {
    switch (value.methodName) {
      case 'FieldValue.delete':
        delete at[last];
        return;
      case 'FieldValue.serverTimestamp':
        at[last] = Timestamp.now();
        return;
      case 'FieldValue.increment':
        at[last] = (typeof at[last] === 'number' ? at[last] : 0) + value.operand;
        return;
      case 'FieldValue.arrayUnion':
        at[last] = [...(Array.isArray(at[last]) ? at[last] : []), ...value.elements.filter((e) => !(at[last] ?? []).some((x) => cmp(x, e) === 0))];
        return;
      case 'FieldValue.arrayRemove':
        at[last] = (Array.isArray(at[last]) ? at[last] : []).filter((x) => !value.elements.some((e) => cmp(x, e) === 0));
        return;
      default:
        throw new Error(`MEM: ${value.methodName} not answered`);
    }
  }
  at[last] = clone(value);
}
const applyFields = (target, data) => {
  for (const [k, v] of Object.entries(data)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) && !isTransform(v) && !(v instanceof Timestamp) && !(v instanceof DocumentReference)) {
      // A plain map is set whole by set(); a merge descends into it.
      setPath(target, [k], {});
      applyFields(target[k], v);
    } else setPath(target, [k], v);
  }
};
const fail = (code, message) => Object.assign(new Error(message), { code });
function apply(op, ref, data, options) {
  const m = coll(collName(ref));
  const entry = m.get(ref.id);
  if (op === 'create') {
    if (entry) throw fail(6, `MEM: ${ref.path} already exists`);
    const next = {};
    applyFields(next, data);
    m.set(ref.id, { data: next, createTime: Timestamp.now() });
  } else if (op === 'set') {
    const merge = options && (options.merge || options.mergeFields);
    const next = merge && entry ? clone(entry.data) : {};
    if (merge) {
      for (const [k, v] of Object.entries(data)) {
        if (v !== null && typeof v === 'object' && !Array.isArray(v) && !isTransform(v) && !(v instanceof Timestamp)) {
          next[k] = next[k] && typeof next[k] === 'object' ? next[k] : {};
          applyFields(next[k], v);
        } else setPath(next, [k], v);
      }
    } else applyFields(next, data);
    m.set(ref.id, { data: next, createTime: entry?.createTime ?? Timestamp.now() });
  } else if (op === 'update') {
    if (!entry) throw fail(5, `MEM: ${ref.path} not found`);
    const next = clone(entry.data);
    for (const [k, v] of Object.entries(data)) setPath(next, k.split('.'), v);
    m.set(ref.id, { data: next, createTime: entry.createTime });
  } else if (op === 'delete') m.delete(ref.id);
  log({ op, path: ref.path, fields: data ? Object.keys(data) : undefined });
}
const updateArgs = (args) => {
  // update(data) or update(field, value, field, value, …)
  if (args.length === 1 || (args.length === 2 && typeof args[0] === 'object' && !(args[0] instanceof FieldPath))) return args[0];
  const out = {};
  for (let i = 0; i + 1 < args.length; i += 2) out[fieldName(args[i])] = args[i + 1];
  return out;
};

const set = (proto, name, fn) => Object.defineProperty(proto, name, { configurable: true, writable: true, value: fn });
set(Query.prototype, 'get', function () {
  const r = runQuery(this);
  count('query', this._queryOptions.collectionId, Math.max(1, r.size));
  return Promise.resolve(r);
});
set(DocumentReference.prototype, 'get', function () {
  count('doc', collName(this), 1);
  return Promise.resolve(snapshot(this, lookup(this)));
});
set(Firestore.prototype, 'getAll', function (...args) {
  const refs = args.filter((a) => a instanceof DocumentReference);
  for (const ref of refs) count('getAll', collName(ref), 1);
  return Promise.resolve(refs.map((ref) => snapshot(ref, lookup(ref))));
});
set(Firestore.prototype, 'listCollections', function () {
  return Promise.resolve([...store.keys()].filter((n) => !n.includes('/')).map((n) => this.collection(n)));
});
set(DocumentReference.prototype, 'listCollections', () => Promise.resolve([]));
set(CollectionReference.prototype, 'listDocuments', function () {
  return Promise.resolve([...coll(this.path).keys()].map((id) => this.doc(id)));
});
if (firestore.AggregateQuery) {
  set(firestore.AggregateQuery.prototype, 'get', function () {
    const snap = runQuery(this._query);
    return Promise.resolve({ data: () => ({ count: snap.size }) });
  });
}
for (const op of ['create', 'set', 'update', 'delete']) {
  set(WriteBatch.prototype, op, function (ref, ...args) {
    (this.__mem ??= []).push([op, ref, op === 'update' ? updateArgs(args) : args[0], op === 'set' ? args[1] : undefined]);
    return this;
  });
}
set(WriteBatch.prototype, 'commit', function () {
  try {
    for (const [op, ref, data, options] of this.__mem ?? []) apply(op, ref, data, options);
  } catch (err) {
    return Promise.reject(err);
  }
  return Promise.resolve((this.__mem ?? []).map(() => ({ writeTime: Timestamp.now() })));
});
for (const op of ['create', 'set', 'update', 'delete']) {
  set(DocumentReference.prototype, op, function (...args) {
    try {
      apply(op, this, op === 'update' ? updateArgs(args) : args[0], op === 'set' ? args[1] : undefined);
    } catch (err) {
      return Promise.reject(err);
    }
    return Promise.resolve({ writeTime: Timestamp.now() });
  });
}
set(Firestore.prototype, 'runTransaction', async function (fn) {
  const writes = [];
  const tx = {
    get: async (target) => {
      if (target instanceof DocumentReference) {
        count('tx', collName(target), 1);
        return snapshot(target, lookup(target));
      }
      const r = runQuery(target);
      count('tx-query', target._queryOptions.collectionId, Math.max(1, r.size));
      return r;
    },
    getAll: async (...args) => args.filter((a) => a instanceof DocumentReference).map((ref) => (count('tx-getAll', collName(ref), 1), snapshot(ref, lookup(ref)))),
    create(ref, data) {
      writes.push(['create', ref, data]);
      return tx;
    },
    set(ref, data, options) {
      writes.push(['set', ref, data, options]);
      return tx;
    },
    update(ref, ...args) {
      writes.push(['update', ref, updateArgs(args)]);
      return tx;
    },
    delete(ref) {
      writes.push(['delete', ref]);
      return tx;
    },
  };
  const result = await fn(tx);
  for (const [op, ref, data, options] of writes) apply(op, ref, data, options);
  return result;
});
for (const m of ['bulkWriter', 'recursiveDelete']) set(Firestore.prototype, m, () => Promise.reject(new Error(`MEM: ${m} not answered`)));

// ── Storage: objects in memory ──
const objects = new Map();
try {
  const { File, Bucket } = load('@google-cloud/storage');
  set(File.prototype, 'save', function (data) {
    objects.set(this.name, Buffer.from(data));
    log({ op: 'storage save', path: this.name, bytes: Buffer.byteLength(data) });
    return Promise.resolve();
  });
  set(File.prototype, 'createWriteStream', function () {
    const chunks = [];
    const name = this.name;
    return new Writable({
      write(chunk, _enc, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
      final(done) {
        objects.set(name, Buffer.concat(chunks));
        log({ op: 'storage stream', path: name, bytes: Buffer.concat(chunks).length });
        done();
      },
    });
  });
  set(File.prototype, 'exists', function () {
    return Promise.resolve([objects.has(this.name)]);
  });
  set(File.prototype, 'download', function () {
    return objects.has(this.name) ? Promise.resolve([objects.get(this.name)]) : Promise.reject(fail(404, 'MEM: no object'));
  });
  set(File.prototype, 'delete', function () {
    objects.delete(this.name);
    log({ op: 'storage delete', path: this.name });
    return Promise.resolve([{}]);
  });
  set(File.prototype, 'getMetadata', function () {
    return objects.has(this.name) ? Promise.resolve([{ size: String(objects.get(this.name).length), name: this.name }]) : Promise.reject(fail(404, 'MEM: no object'));
  });
  set(File.prototype, 'getSignedUrl', function () {
    return Promise.resolve([`https://memory.invalid/${encodeURIComponent(this.name)}`]);
  });
  set(Bucket.prototype, 'getFiles', function (opts = {}) {
    const files = [...objects.keys()].filter((n) => !opts.prefix || n.startsWith(opts.prefix)).map((n) => this.file(n));
    return Promise.resolve([files]);
  });
} catch {
  /* no storage module here */
}

globalThis.__memDoc = (collection, id) => (store.get(collection)?.get(id)?.data ?? null);
