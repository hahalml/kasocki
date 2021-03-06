'use strict';

/**
 * Usage:
 * const Kasocki = require('kasocki');
 * io.on('connection', (socket) => {
 *     let kasocki = new Kasocki(socket, configOptions});
 * });
 */

const utils                  = require('./utils');
const objectutils            = require('./objectutils');


const errors                 = require('./error.js');
const KasockiError           = errors.KasockiError;
const InvalidAssignmentError = errors.InvalidAssignmentError;
const TopicNotAvailableError = errors.TopicNotAvailableError;
const NotSubscribedError     = errors.NotSubscribedError;
const AlreadySubscribedError = errors.AlreadySubscribedError;
const AlreadyStartedError    = errors.AlreadyStartedError;
const AlreadyClosingError    = errors.AlreadyClosingError;
const InvalidFilterError     = errors.InvalidFilterError;
const DeserializationError   = errors.DeserializationError;

const kafka           = require('node-rdkafka');
const P               = require('bluebird');
const bunyan          = require('bunyan');
const _               = require('lodash');


// Set RegExp's toJSON method to toString.
// This allows it to be transparently 'serialized'
// for logging and ackCallback results.
// Yes this is an 'antipattern', but it simplifies
// building, logging and returning configured filters to clients.
RegExp.prototype.toJSON = RegExp.prototype.toString;

/**
 * Represents a Kafka Consumer -> socket.io connection.
 *
 * This creates a new Kafka Consumer and passes consumed
 * messages to the connected socket.io client.
 */
class Kasocki {
    /**
     * @param {socket.io Object} socket
     *
     * @param {Object}   options.
     *
     * @param {Object}   options.kafkaConfig: suitable for passing to
     *                   rdkafka.KafkaConsumer constructor.  group.id and
     *                   enable.auto.commit be provided and will be overridden.
     *                   metadata.broker.list defaults to localhost:9092,
     *                   and client.id will also be given a sane default.
     *                   Use the 'default_topic_config' property to configure
     *                   default topic related settings like auto.offset.reset.
     *
     * @param {Object}   options.allowedTopics:  Array of topic names that can be
     *                   subscribed to.  If this is not given, all topics are
     *                   allowed.
     *
     * @param {Object}   options.logger:  bunyan Logger.  A child logger will be
     *                   created from this. If not provided, a new bunyan Logger
     *                   will be created.
     *
     * @param {function} options.deserializer:  This function takes a single
     *                   Kafka message and returns a deserialized
     *                   and possibly augmented message as a JS object.
     *                   If not specified, this will use
     *                   lib/utils.js/deserializeKafkaMessage.
     *
     * @param {function} options.matcherFactory:  This function takes an object
     *                   representing filters to match messages against.
     *                   if the filters object is invalid, matcherBuilder
     *                   should throw an Error. matcherBuilder should return a new
     *                   function that will be used to match deserialized messages.
     *                   That function should return true if a message matches,
     *                   false otherwise, but it should not throw any Errors.  If
     *                   any errors are encountered by the matcher function,
     *                   then they should be accessable as matcher.errors after
     *                   the a matcher call.  At any time, the filters used to create
     *                   the matcher function should be available as matcher.filters, so
     *                   that a user of the function can inspect the filters
     *                   that are used by the matcher function.
     *                   If not specified, this will use
     *                   lib/objectutils.js/createMatcherFunctionWithFilters.
     *
     * @param {Object}   options.kafkaEventHandlers: Object of
     *                   eventName: function pairs.  Each eventName
     *                   should match an event fired by the node-rdkafka
     *                   KafkaConsumer.  This is useful for installing
     *                   Custom handlers for things like stats and logging
     *                   librdkafka callbacks.
     *
     * @param {Object}   options.statsd statsd client instance.  If this is
     *                   provided, this client instance will be used to record
     *                   Kasocki metrics.  No key prefix is added, so if you
     *                   want to record per-socket metrics, make sure the
     *                   statsd client instance you pass here has some kind of
     *                   unique per-socket key prefix configured on it.
     *
     * @constructor
     */
    constructor(socket, options) {
        this.socket     = socket;
        this.name       = this.socket.id;
        this.filters    = null;

        // True if the kafkaConsumer has been subscribed or assigned
        this.subscribed = false;

        // True if consume _loop has started
        this.running    = false;

        // True if close has been called
        this.closing    = false;

        const bunyanConfig = {
            socket:      this.name,
            serializers: {
                // KasockiErrors know how to serialize themselves well
                // with toJSON.  If an err object has a toJSON method,
                // then use it to serialize the error, otherwise use
                // the standard bunyan error serialize
                err: (e) => {
                    if (_.isFunction(e.toJSON)) {
                        return e.toJSON();
                    }
                    else {
                        return bunyan.stdSerializers.err(e);
                    }
                }
            }
        };

        this.options = options || {};
        // If we are given a logger, assume it is a bunyan logger
        // and create a child.
        if (this.options.logger) {
            this.log = options.logger.child(bunyanConfig);
        }
        // Else create a new logger, with src logging enabled for dev mode
        else {
            this.log = bunyan.createLogger(
                Object.assign(bunyanConfig, { name: 'kasocki', src: true, level: 'debug' })
            );
        }
        this.log.info(`Creating new Kasocki instance ${this.name}.`);

        // If statsd client instance is given, _metric will
        // send it stats.
        this.statsd = this.options.statsd;

        // Use this to deserialize and augment messages consumed from Kafka.
        this.deserializer = this.options.deserializer || utils.deserializeKafkaMessage;
        this.log.debug(
            { deserializer: this.deserializer.toString() },
            `Deserializing messages with function ${this.deserializer.name}`
        );

        this.matcherFactory = options.matcherFactory ||
            objectutils.createMatcherFunctionWithFilters;
        this.log.debug(
            { matcherFactory: this.matcherFactory.toString() },
            'Creating match function from filters with messages ' +
            `with function ${this.matcherFactory.name}`
        );

        // Default kafkaConfigs to use if not provided in kafkaConfig.
        const defaultKafkaConfig = {
            'metadata.broker.list': 'localhost:9092',
            'client.id': `kasocki-${this.name}`
        };

        // These configs MUST be set for a Kasocki KafkaConsumer.
        // The are not overridable.
        // We want to avoid making Kafka manage consumer info
        // for websocket clients.
        //   A. no offset commits
        //   B. no consumer group management/balancing.
        // A. is achieved simply by setting enable.auto.commit: false.
        // B. is more complicated. Until
        // https://github.com/edenhill/librdkafka/issues/593 is resolved,
        // there is no way to 100% keep Kafka from managing clients.  So,
        // we fake it by using the socket name, which will be unique
        // for each socket instance.  Since we use assign() instead of
        // subscribe(), at least we don't have to deal with any rebalance
        // callbacks.
        const mandatoryKafkaConfig = {
            'enable.auto.commit': false,
            'group.id': `kasocki-${this.name}`
        };

        // Merge provided over default configs, and mandatory over all.
        this.kafkaConfig = Object.assign(
            defaultKafkaConfig,
            this.options.kafkaConfig,
            mandatoryKafkaConfig
        );
    }


    /**
     * Creates a new KafkaConsumer instances, connects it,
     * and finishes configuring Kasocki.  Emits
     * a socket 'ready' event when ready.
     *
     * @return Promise
     */
    connect() {
        // Create and connect a new KafkaConsumer instance
        return utils.createKafkaConsumerAsync(this.kafkaConfig)

        // Save our consumer
        .then((consumer) => {
            // TODO: tests for this:
            if (this.options.kafkaEventHandlers) {
                Object.keys(this.options.kafkaEventHandlers).forEach((event) => {
                    this.log.debug(
                        `Registering Kafka event ${event} to be handled by ` +
                        `function ${this.options.kafkaEventHandlers[event].name}`
                    );
                    consumer.on(event, this.options.kafkaEventHandlers[event]);
                });
            }
            this.kafkaConsumer = consumer;
        })

        // Save intersection of allowedTopics and existent topics.
        // These will be given to the client on ready so it
        // knows what topics are available.
        .then(() => {
            this.availableTopics = utils.getAvailableTopics(
                this.kafkaConsumer._metadata.topics,
                this.options.allowedTopics
            );
            // Throw Error if there are no available topics.  This
            // will fail initialization and disconnect the client.
            if (this.availableTopics.length === 0) {
                throw new KasockiError(
                    'No topics available for consumption. ' +
                    'This likely means that the configured allowedTopics ' +
                    'do not currently exist.',
                    { allowedTopics: this.options.allowedTopics }
                );
            }
        })

        // Register all socket event handlers using this._wrapHandler.
        .then(() => {
            ['subscribe', 'filter', 'consume', 'start', 'stop', 'disconnect']
            .forEach((f) => {
                this.log.debug(`Registering socket event '${f}' to be handled by this.${f}`);
                this.socket.on(f, this._wrapHandler(this[f], f));
            });
        })

        // KafkaConsumer has connected, and handlers are registered.
        // Tell the socket.io client we are ready and what topics
        // are available for consumption.
        .then(() => {
            this.socket.emit('ready', this.availableTopics);
        })

        // If anything bad during initialization, disconnect now.
        .catch((e) => {
            this.log.error(e, 'Failed Kasocki initialization.');
            // TODO: communicate error back to client?
            this.disconnect();
        });
    }


    /**
     * Returns a new function that wraps handlerFunction
     * with Promise functionality, error handling, logging, and
     * auto calling of the socket ack callback appropriately.
     *
     * If handlerFunction throws or returns an Error, it will
     * be augmented and serialized and then given to the client's
     * emit ack callback as the first argument.  The return value of
     * handlerFunction will be given to the client's emit ack callback as
     * the second argument.
     * If result returned from handlerFunction is a Promise,
     * it will be resolved before cb is called.
     * If cb is not defined (e.g. during a disconnect event)
     * it will not be called.
     *
     * If any error is encountered, it will be emitted as an 'err'
     * socket event to the client.
     *
     * @param {function} handlerFunction a method that will be
     *                   called as a socket.on handler.
     *
     * @param {string}   socketEvent the name of the socket event
     *                   that this handlerFunction will be called for.
     *
     * @return Promise   although this probably won't be used.
     */
    _wrapHandler(handlerFunction, socketEvent) {
        return (arg, cb) => {
            this.log.debug(
                { socketEvent: socketEvent, arg: arg },
                `Handling socket event ${socketEvent}`
            );

            this._metric('increment', `socketio.event.${socketEvent}`);

            // Wrap handlerFunction in a Promise.  This makes
            // error via .catch really easy, and also makes
            // returning a Promise from a handlerFunction work.
            return new P((resolve, reject) => {
                const result = handlerFunction.call(this, arg);

                // Reject if we are returned an error.
                if (result instanceof Error) {
                    return reject(result);
                }
                else {
                    return resolve(result);
                }
            })

            // Cool, everything went well, call cb with the result value.
            .then((v) => {
                if (cb) {
                    cb(undefined, v);
                }
            })

            // We either rejected or were thrown an Error.
            // Call cb with the augmented and serialized error.
            .catch((e) => {
                e = this._error(e, { socketEvent: socketEvent });
                if (cb) {
                    cb(e, undefined);
                }
                // Also emit a socket event 'err', as an alternative
                // way to receive errors.  NOTE: we can't use 'error',
                // as it is reserved by socket.io.
                this.socket.emit('err', e);
            });
        };
    }


    /**
     * Assign topic partitions for consumption to this KafkaConsumer.
     * A Kasocki instance can only be subscribed once; its subscription
     * can not be changed.  Topic regexes are not supported.
     *
     * Note that this does not actually call KafkaConsumer.subscribe().  Instead
     * it uses KafkaConsumer.assign().  It does this in order to avoid getting
     * rebalances from Kafka.  A Kasocki instance always has a unique group.id,
     * so there will never be another consumer to balance with.
     * See: https://github.com/edenhill/librdkafka/issues/593
     *
     * Also see 'Notes on Kafka consumer state' in this repository's README.
     *
     * @param  {Array} assignments, either an Array of topic names, or
     *                 an Array of objects with topic, partition, offset assignments.
     * @return {Array} topic partition assigments as assigned
     */
    subscribe(assignments) {
        if (this.closing) {
            this.log.warn('Cannot subscribe, already closing.');
            return;
        }
        else if (this.subscribed) {
            throw new AlreadySubscribedError(
                'Cannot subscribe, topics have already ' +
                'been subscribed or assigned.',
                { assignments: assignments }
            );
        }

        // Convert to a single element Array if we were given a string.
        if (_.isString(assignments)) {
            assignments = [assignments];
        }

        try {
            utils.validateAssignments(assignments);
        }
        catch (e) {
            // re raise as InvalidAssignmentError.
            throw new InvalidAssignmentError(e);
        }

        // If the first element is a string, we assume assignments is an
        // Array of topic names (validateAssignments assures this).
        if (_.isString(assignments[0])) {
            // Check that all topic names are allowed
            this._checkTopicsAvailable(assignments);
            // Build topic-partition assignments starting at latest.
            assignments = utils.buildAssignments(
                this.kafkaConsumer._metadata.topics,
                assignments
            );
            this.log.info(
                { assignments: assignments },
                'Subscribing to topics, starting at latest in each partition.'
            );
        }
        // Else assume we are trying to assign at particular offsets.
        // Note that this does not check that the topic
        // partition assignment makes any sense.  E.g. it is possible to
        // subscribe to non existent topic-partition this way.  In that case,
        // nothing will happen.
        else {
            // Check that all topic names are allowed
            this._checkTopicsAvailable(assignments.map(a => a.topic));
            this.log.info(
                { assignments: assignments },
                'Subscribing to topic partitions, starting at assigned offsets.'
            );
        }

        this.kafkaConsumer.assign(assignments);
        this.subscribed = true;

        return assignments;
    }


    /**
     * Throws TopicNotAvailableError if any topic in topics Array is not
     * in the list of available topics.
     *
     * @param {Array} topics
     * @throws TopicNotAvailableError if any of the topics are not available.
     */
    _checkTopicsAvailable(topics) {
        topics.forEach((topic) => {
            if (this.availableTopics.indexOf(topic) < 0) {
                throw new TopicNotAvailableError(
                    `Topic '${topic}' is not available for consumption.`,
                    { availableTopics: this.availaleTopics }
                );
            }
        });
    }


    /**
     * Sets the filters that will be used to filter consumed messages.
     * this.filterBuilder will validate and convert these into
     * filters suitable for passing to this.matcher.
     *
     * @param  {Object} filters
     * @throws {InvalidFilterError}
     * @return {Object} filters
     */
    filter(filters) {
        // Filters can be disabled.
        if (!filters) {
            this.matcher = undefined;
            return;
        }

        try {
            // build a new matcher function using newly provided filters.
            this.matcher = this.matcherFactory(filters);
        }
        catch (e) {
            // Re raise as InvalidFilterError
            throw new InvalidFilterError(e);
        }

        this.log.info(
            { matcher: this.matcher.toString(), filters: this.matcher.filters },
            'Now filtering using matcher function.'
        );
        return this.matcher.filters;
    }


    /**
     * Consumes messages from Kafka until we find one that parses and matches
     * the configured filters, and then returns a Promise of that message.
     *
     * @return {Promise<Object>} Promise of first matched messaage
     */
    consume() {
        if (this.closing) {
            // Not throwing an error here, since this is likely to happen
            // in normal use case when consuming a stream.
            // An consume call from _loop might overlap with
            // a disconnect.
            this.log.warn('Cannot consume, already closing.');
            return;
        }
        if (!this.subscribed) {
            throw new NotSubscribedError(
                'Cannot consume. Topics have not been subscribed or assigned.'
            );
        }

        // Consume a message from Kafka
        return this.kafkaConsumer.consumeAsync()

        // Deserialize the consumed message
        .then(this._deserialize.bind(this))

        // Match it against any configured filters
        .then(this._match.bind(this))

        // Catch Kafka errors, log and re-throw real errors,
        // ignore harmless ones.
        .catch({ origin: 'kafka' }, (e) => {
            // Ignore innoculous Kafka errors.
            switch (e.code) {
                case kafka.CODES.ERRORS.ERR__PARTITION_EOF:
                case kafka.CODES.ERRORS.ERR__TIMED_OUT:
                    this.log.trace(
                        { err: e },
                        'Encountered innoculous Kafka error: ' +
                        `'${e.message} (${e.code}). Delaying 100 ms before continuing.`
                    );
                    // Delay a small amount after innoculous errors to keep
                    // the consume loop from being so busy when there are no
                    // new messages to consume.
                    return P.delay(100);
                default:
                    this.log.error(
                        { err: e },
                        'Caught Kafka error while attempting to consume a message.'
                    );
                    throw e;
            }
        })

        // Log and ignore DeserializationError.  We don't want to fail the
        // client if the data in a topic is bad.
        .catch(DeserializationError, (e) => {
            this.log.error(e);
        })

        // Any unexpected error will not be caught
        // here.  It will be returned to the client as error in the
        // socket.io event ack callback and emitted as an 'err' socket event.

        // If we found a message, return it, else keep looking.
        .then((message) => {
            if (message) {
                this.log.trace({ message: message }, 'Consumed message.');
                return message;
            }
            else {
                this.log.trace('Have not yet found a message while consuming, trying again.');
                return this.consume();
            }
        });
    }


    /**
     * Starts the consume loop and returns a resolved Promise.
     * This starts a consume loop in the background, and as such
     * cannot report any error from it.
     *
     * @throws {AlreadyStartedError}
     * @throws {AlreadyClosingError}
     * @throws {NotSubscribedError}
     * @return {Promise} resolved.
     */
    start() {
        // Already running
        if (this.running) {
            throw new AlreadyStartedError('Cannot start, already started.');
        }
        else if (this.closing) {
            throw new AlreadyClosingError('Cannot start, already closing.');
        }
        else if (!this.subscribed) {
            throw new NotSubscribedError(
                'Cannot start, topics have not been subscribed or assigned.'
            );
        }
        else {
            this.running = true;

            // Loop until not this.running or until error.
            this.log.info('Starting');
            this._loop();
            // Return a resolved promise.
            // The consume loop will continue to run.
            return P.resolve();
        }
    }


    /**
     * Stops the consume loop.  Does nothing
     * if not this.running.
     */
    stop() {
        if (this.running) {
            this.log.info('Stopping.');
            this.running = false;
        }
        else {
            this.log.info(
                'Stop socket event received, but consume loop was not running'
            );
        }
    }


    /**
     * Stops the consume loop, and closes the kafkaConsumer,
     * and disconnects the websocket.
     */
    disconnect() {
        this.log.info('Closing kafka consumer and disconnecting websocket.');
        this.running = false;
        this.closing = true;

        if ('kafkaConsumer' in this) {
            this.kafkaConsumer.disconnect();
            delete this.kafkaConsumer;
        }

        this.socket.disconnect(true);
    }


    /**
     * While this.running, calls consume() and then emits 'message' in a loop.
     */
    _loop() {
        if (!this.running) {
            this.log.debug('Consume loop stopping.');
            return P.resolve();
        }

        // Consume, emit the message, and then consume again.
        return this.consume()
        .then((message) => {
            this.socket.emit('message', message);
            return this._loop();
        });
    }


    /**
     * Returns a Promise of an Object deserialized from kafkaMessage.
     * This calls the this.deserializer function configured using
     * options.deserializer in the Kasocki constructor.
     * If this.deserializer throws any error, the error will be
     * wrapped as a DeserializationError and thrown up to the caller.
     *
     * @param  {Object}          kafkaMessage from a KafkaConsumer.consume call.
     * @return {Promise{Object}} derialized and possible augmented message.
     */
    _deserialize(kafkaMessage) {
        return new P((resolve, reject) => {
            resolve(this.deserializer(kafkaMessage));
        })
        // Catch any error thrown by this.deserializer and
        // wrap it as a DeserializationError.
        .catch((e) => {
            throw new DeserializationError(
                'Failed deserializing and building message from Kafka.',
                { kafkaMessage: kafkaMessage, originalError: e }
            );
        });
    }

    /**
     * Returns message if the message matches configured filters via
     * the matcher function built by this.matcherFactory, false otherwise.
     *
     * @param   {Object} deserialized message from Kafka
     * @return  {Object|false}  message will be returned if it matches, otherwise false.
     */
    _match(message) {
        // If no matcher function is configured, i.e. no filters
        // have been given, then return the message now.
        if (!this.matcher) {
            return message;
        }

        // Else match the mesage
        if (this.matcher(message)) {
            return message;
        }
        else {
            this.log.trace(
                { message: message, filters: this.matcher.filters, errors: this.matcher.errors },
                'Consumed and deserialized message did not match configured filters.'
            );
            return false;
        }
    }

    /**
     * Converts e to a KasockiError if it isn't one already, logs it,
     * and then augments and returns the KasockiError without the stack so
     * it is suitable for returning to clients.
     *
     * @param  {Error|String}  e
     * @param  {Object} extra - extra information to be serialized as
     *                  fields on the error object.
     *
     * @return {Object} serialized error without stack.
     */
    _error(e, extra) {
        if (!(e instanceof KasockiError)) {
            e = new KasockiError(e, extra);
        }
        else if (extra) {
            e = Object.assign(e, extra);
        }

        this.log.error({ err: e });

        // Add the socket name and delete the stack trace for the
        // error that will be sent to client.
        e.socket = this.name;
        delete e.stack;

        return e;
    }

    /**
     * Helper function for conditionally sending metrics to statsd.
     *
     * @param {string} method a statsd client method.
     * @param {Array}  statsdArgs to statsd client method
     *
     */
    _metric(method, statsdArgs) {
        if (_.isString(statsdArgs)) {
            statsdArgs = [statsdArgs];
        }

        const key = statsdArgs[0];
        let logMessage = `${method} metric ${key}`;
        let logObject = { method: method, key: key };

        // Append rest of statsd args to log if they exist.
        if (statsdArgs.length > 1) {
            logObject.args = statsdArgs.slice(1);
            logMessage += ':' + logObject.args.join(':');
        }
        this.log.trace(logObject, logMessage);

        // If statsd is configured, then send a metric
        if (_.isObject(this.statsd) &&  _.isFunction(this.statsd[method])) {
            this.statsd[method].call(statsdArgs);
        }
    }

}


module.exports = Kasocki;
