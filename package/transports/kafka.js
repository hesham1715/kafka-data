'use strict';

/**
 * Creates a Kafka transport that publishes HTTP log payloads to a Kafka topic.
 *
 * Requires `kafkajs` to be installed in your project:
 *   npm install kafkajs
 *
 * @param {object} config
 * @param {string[]}  config.brokers      - e.g. ['localhost:9092']
 * @param {string}    config.topic        - Kafka topic to publish to
 * @param {string}   [config.clientId]    - Kafka client id (default: 'http-log-transport')
 * @param {object}   [config.ssl]         - kafkajs SSL options
 * @param {object}   [config.sasl]        - kafkajs SASL options
 * @param {object}   [config.producerConfig] - extra kafkajs producer options
 * @param {function} [config.serialize]   - custom serializer; default: JSON.stringify
 * @param {string}   [config.messageKey]  - static Kafka message key; default: undefined
 * @param {function} [config.getKey]      - dynamic key fn `(payload) => string`
 * @param {boolean}  [config.wrapPayload] - wrap message as { eventType, publishedAt, payload } (default: true)
 * @param {string}   [config.eventType]   - envelope event type (default: topic)
 * @param {function} [config.getPublishedAt] - fn `(payload) => ISO timestamp`
 *
 * @returns {{ connect, send, disconnect }}
 */
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
    clientId = 'http-log-transport',
    ssl,
    sasl,
    producerConfig = {},
    serialize = JSON.stringify,
    messageKey,
    getKey,
    wrapPayload = true,
    eventType = topic,
    getPublishedAt,
  } = config;

  const kafka = new Kafka({
    clientId,
    brokers,
    ...(ssl  !== undefined && { ssl }),
    ...(sasl !== undefined && { sasl }),
  });

  const producer = kafka.producer(producerConfig);
  let connected = false;
  let connecting = null;

  async function connect() {
    if (connected) return;
    if (connecting) return connecting;
    connecting = producer.connect().then(() => {
      connected = true;
      connecting = null;
    });
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
            ? String(resolvedRequestId)
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

    await producer.send({
      topic,
      messages: [{ key, value }],
    });
  }

  async function disconnect() {
    if (!connected) return;
    await producer.disconnect();
    connected = false;
  }

  return { connect, send, disconnect };
}

module.exports = { createKafkaTransport };
