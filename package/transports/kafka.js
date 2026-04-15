'use strict';

/**
 * Creates a Kafka transport that publishes HTTP log payloads to a Kafka topic.
 *
 * Requires `kafkajs` to be installed in your project:
 *   npm install kafkajs
 *
 * @param {object} config
 * @param {string[]}  config.brokers           - e.g. ['localhost:9092']
 * @param {string}    config.topic             - Kafka topic to publish to
 * @param {string}   [config.clientId]         - Kafka client id (default: 'http-log-transport')
 * @param {object}   [config.ssl]              - kafkajs SSL options
 * @param {object}   [config.sasl]             - kafkajs SASL options
 * @param {object}   [config.producerConfig]   - extra kafkajs producer options
 * @param {function} [config.serialize]        - custom serializer; default: JSON.stringify
 * @param {string}   [config.messageKey]       - static Kafka message key; default: undefined
 * @param {function} [config.getKey]           - dynamic key fn `(payload) => string`
 * @param {boolean}  [config.wrapPayload]      - wrap message as { eventType, publishedAt, payload } (default: true)
 * @param {string}   [config.eventType]        - envelope event type (default: topic)
 * @param {function} [config.getPublishedAt]   - fn `(payload) => ISO timestamp`
 *
 * Partition / scaling options:
 * @param {number}   [config.partition]        - static partition number; overrides key-based routing
 * @param {function} [config.getPartition]     - dynamic partition fn `(payload) => number`; takes precedence over `partition`
 * @param {boolean}  [config.autoCreateTopic]  - create the topic on first connect if it does not exist (default: false)
 * @param {number}   [config.numPartitions]    - number of partitions when auto-creating the topic (default: 1)
 * @param {number}   [config.replicationFactor]- replication factor when auto-creating the topic (default: 1)
 * @param {number}   [config.metadataMaxAge]   - ms between partition-count metadata refreshes (default: 300000)
 *                                               Lower values (e.g. 30000) let the producer detect externally-added
 *                                               partitions faster; higher values reduce broker metadata requests.
 *
 * @returns {{ connect, send, disconnect }}
 */

// W3C traceparent: 00-{traceId32hex}-{parentId16hex}-{flags}
// Use only the traceId segment as the partition key for uniform distribution.
const TRACEPARENT_RE = /^[0-9a-f]{2}-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i;

function resolveKey(id) {
  if (typeof id !== 'string') return String(id);
  const m = TRACEPARENT_RE.exec(id);
  return m ? m[1] : id;
}

function createKafkaTransport(config) {
  if (!config || !Array.isArray(config.brokers) || config.brokers.length === 0) {
    throw new TypeError('createKafkaTransport: config.brokers must be a non-empty array');
  }
  if (typeof config.topic !== 'string' || !config.topic) {
    throw new TypeError('createKafkaTransport: config.topic must be a non-empty string');
  }

  let Kafka;
  try {
    ({ Kafka } = require('kafkajs'));
  } catch {
    throw new Error(
      'createKafkaTransport requires "kafkajs" to be installed.\n' +
      'Run: npm install kafkajs',
    );
  }

  const {
    brokers,
    topic,
    clientId        = 'http-log-transport',
    ssl,
    sasl,
    producerConfig  = {},
    serialize       = JSON.stringify,
    messageKey,
    getKey,
    wrapPayload     = true,
    eventType       = topic,
    getPublishedAt,
    // ── partition / scaling ─────────────────────────────────────────────────
    partition,
    getPartition,
    autoCreateTopic   = false,
    numPartitions     = 1,
    replicationFactor = 1,
    metadataMaxAge    = 300_000,
  } = config;

  const kafka = new Kafka({
    clientId,
    brokers,
    metadataMaxAge,
    ...(ssl  !== undefined && { ssl }),
    ...(sasl !== undefined && { sasl }),
  });

  const producer = kafka.producer(producerConfig);
  let connected  = false;
  let connecting = null;

  async function connect() {
    if (connected) return;
    if (connecting) return connecting;

    connecting = (async () => {
      if (autoCreateTopic) {
        const admin = kafka.admin();
        await admin.connect();
        try {
          await admin.createTopics({
            waitForLeaders: true,
            topics: [{ topic, numPartitions, replicationFactor }],
          });
        } catch {
          // Topic already exists — ignore; KafkaJS throws when topic is present.
        } finally {
          await admin.disconnect();
        }
      }

      await producer.connect();
      connected  = true;
      connecting = null;
    })();

    return connecting;
  }

  async function send(payload) {
    if (!connected) await connect();

    const resolvedRequestId =
      payload && typeof payload === 'object'
        ? payload.requestId ??
          (payload.request &&
          typeof payload.request === 'object' &&
          payload.request.requestId !== undefined
            ? payload.request.requestId
            : undefined)
        : undefined;

    const key =
      typeof getKey === 'function'
        ? String(getKey(payload))
        : messageKey !== undefined
          ? String(messageKey)
          : resolvedRequestId !== undefined && resolvedRequestId !== null
            ? resolveKey(resolvedRequestId)
            : null;

    const outboundPayload = wrapPayload
      ? {
          eventType,
          publishedAt:
            (typeof getPublishedAt === 'function' && getPublishedAt(payload)) ||
            (payload &&
            typeof payload === 'object' &&
            typeof payload.timestamp === 'string'
              ? payload.timestamp
              : new Date().toISOString()),
          payload,
        }
      : payload;

    let value;
    try {
      value = serialize(outboundPayload);
    } catch (err) {
      throw new Error('createKafkaTransport: failed to serialize payload — ' + err.message);
    }

    // Resolve partition: getPartition fn → static partition → undefined (key-based routing)
    let resolvedPartition;
    if (typeof getPartition === 'function') {
      resolvedPartition = getPartition(outboundPayload);
    } else if (partition !== undefined) {
      resolvedPartition = partition;
    }

    await producer.send({
      topic,
      messages: [{
        key,
        value,
        ...(resolvedPartition !== undefined && { partition: resolvedPartition }),
      }],
    });
  }

  async function disconnect() {
    if (!connected) {
      // If a connect() is still in-flight, wait for it before disconnecting.
      if (connecting) await connecting.catch(() => {});
      if (!connected) return;
    }
    await producer.disconnect();
    connected = false;
  }

  return { connect, send, disconnect };
}

module.exports = { createKafkaTransport };
