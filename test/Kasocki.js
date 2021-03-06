'use strict';


// mocha defines to avoid JSHint breakage
/* global describe, it, before, beforeEach, after, afterEach */

//  NOTE: these tests require a running kafka broker at localhost:9092

const Kasocki      = require('../lib/Kasocki');

const assert       = require('assert');
const P            = require('bluebird');
const bunyan       = require('bunyan');
const http         = require('http');
const socket_io    = require('socket.io');

/**
 * Kasocki socket.io test server.
 * Connect to this with a client on port 6927.
 * Kafka broker must be running at localhost:9092.
 */
class TestKasockiServer {

    constructor(port, kasockiOptions) {
        this.port = port;
        this.server = http.createServer();
        this.io = socket_io(this.server);

        this.log = bunyan.createLogger({
            name: 'KasockiTest',
            // level: 'trace',
            level: 'fatal',
        });

        kasockiOptions = kasockiOptions || {};
        kasockiOptions.logger = this.log;

        this.io.on('connection', (socket) => {
            // Kafka broker should be running at localhost:9092.
            // TODO: How to Mock Kafka broker and prep topics and data?
            this.kasocki = new Kasocki(socket, kasockiOptions);
            this.kasocki.connect()
            .then(() => {
                this.log.debug('Connected Kasocki ready');
            });

            // TODO: This is a total hack.  Calling KafkaConsumer
            // disconnect can result in hung processes until
            // messages/consumer connections are GCed.  This
            // can cause tests to never finish.  By
            // deleting the kafka consumer instance before
            // Kasocki handles the socket.io client disconnect event,
            // Kasocki will not attempt to call kafka consumer disconnec().
            // See: https://github.com/Blizzard/node-rdkafka/issues/5
            socket.on('disconnect', () => {
                delete this.kasocki.kafkaConsumer;
            });
        });

    }

    listen() {
        this.server.listen(this.port);
    }

    close() {
        this.server.close();
    }
}


assert.topicOffsetsInMessages = (messages, topicOffsets) => {
    topicOffsets.forEach((topicOffset) => {
        let foundIt = messages.find((msg) => {
            return (
                msg._kafka.topic === topicOffset.topic &&
                msg._kafka.offset === topicOffset.offset
            );
        });
        // assert that messages contained a message
        // consumed from topic at offset.
        assert.ok(foundIt, `message in ${topicOffset.topic} at ${topicOffset.partition} should be found`);
    });
}

assert.topicOffsetsInAssignments = (assignments, topicOffsets) => {
    topicOffsets.forEach((t) => {
        let foundIt = assignments.find((assigned) => {
            return (
                assigned.topic === t.topic &&
                assigned.partition === t.partition &&
                assigned.offset === t.offset
            );
        });
        assert.ok(
            foundIt,
            `topic ${t.topic} in partition ${t.partition} was subscribed and assigned offset ${t.offset}`
        );
    });
}

assert.errorNameEqual = (e, errorName) => {
    assert.equal(e.name, errorName, `should error with ${errorName}, got ${e.name} instead.`);
}

describe('Kasocki', function() {
    this.timeout(30000);

    const topicNames = [
        'kasocki_test_01',
        'kasocki_test_02',
        'kasocki_test_03'
    ];

    const serverPort            = 6900;
    const server                = new TestKasockiServer(serverPort);

    const restrictiveServerPort = 6901;
    const restrictiveServer     = new TestKasockiServer(restrictiveServerPort, {
        allowedTopics: topicNames
    });

    function createClient(port) {
        const client = require('socket.io-client')(`http://localhost:${port}/`);
        // create a bound function for ease of passing to a .then handler.
        client._disconnect = client.disconnect.bind(client);
        return P.promisifyAll(client);
    }

    before(function() {
        server.listen();
        restrictiveServer.listen();
    });

    after(function() {
        server.close();
        restrictiveServer.close();
    });

    // == Test connect

    it('should connect and return existent topics', (done) => {
        const client = createClient(serverPort);
        client.on('ready', (availableTopics) => {
            // assert that each of these is in available topics returned by
            // client on ready.  We can't be certain about what other topics
            // might exist on our Kafka broker, and without configuring Kasocki
            // with allowedTopics, we will get all topics.  We create
            // these topics in clean_kafka.sh, so we know that at least
            // these should exist and be available.
            ['kasocki_test_01', 'kasocki_test_02', 'kasocki_test_03'].forEach((t) => {
                assert.ok(availableTopics.indexOf(t) >= 0, `${t} not in available topics`);
            });
            client.disconnect();
            done();
        });
    });

    it('should connect and return only allowed topics', (done) => {
        const client = createClient(restrictiveServerPort);
        client.on('ready', (availableTopics) => {
            assert.equal(
                availableTopics.length,
                topicNames.length,
                `Only ${topicNames.length} topics should be available for consumption`
            );
            // Only allowedTopics should be returned on ready.
            topicNames.forEach((t) => {
                let foundIt = availableTopics.find((availableTopic) => {
                    return (availableTopic === t);
                });
                assert.ok(foundIt, `topic ${t} is available for consumption`);
            });
            client.disconnect();
            done();
        });
    });


    // == Test subscribe to latest

    it('should subscribe to a single topic', (done) => {
        const client = createClient(serverPort);
        client.on('ready', (availableTopics) => {
            client.emitAsync('subscribe', [topicNames[0]])
            .then((assignments) => {
                let shouldBe = [ { topic: topicNames[0], partition: 0, offset: -1 } ]
                assert.equal(
                    assignments.length,
                    shouldBe.length,
                    `${shouldBe.length} topic partitions should be assigned, got ${assignments.length}`
                );
                assert.topicOffsetsInAssignments(assignments, shouldBe);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should subscribe to multiple topics', (done) => {
        const client = createClient(serverPort);
        client.on('ready', (availableTopics) => {
            client.emitAsync('subscribe', [topicNames[0], topicNames[1]])
            .then((assignments) => {
                let shouldBe = [
                    { topic: topicNames[0], partition: 0, offset: -1 },
                    { topic: topicNames[1], partition: 0, offset: -1 }
                ]
                assert.equal(
                    assignments.length,
                    shouldBe.length,
                    `${shouldBe.length} topic partitions should be assigned, got ${assignments.length}`
                );
                assert.topicOffsetsInAssignments(assignments, shouldBe);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should fail subscribe to a non Array', (done) => {
        const client = createClient(serverPort);
        client.on('ready', (availableTopics) => {
            client.emitAsync('subscribe', {'this': 'will fail'})
            .catch((e) => {
                assert.errorNameEqual(e, 'InvalidAssignmentError');
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });


    it('should fail subscribe to a single non existent topic', (done) => {
        const client = createClient(serverPort);
        client.on('ready', (availableTopics) => {
            client.emitAsync('subscribe', ['non-existent-topic'])
            .catch((e) => {
                assert.errorNameEqual(e, 'TopicNotAvailableError');
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should fail subscribe to multiple topics, one of which does not exist', (done) => {
        const client = createClient(serverPort);
        client.on('ready', (availableTopics) => {
            client.emitAsync('subscribe', [topicNames[0], 'non-existent-topic'])
            .catch((e) => {
                assert.errorNameEqual(e, 'TopicNotAvailableError');
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should subscribe to a single allowed topic', (done) => {
        const client = createClient(restrictiveServerPort);
        client.on('ready', (availableTopics) => {
            client.emitAsync('subscribe', [topicNames[0]])
            .then((assignments) => {
                let shouldBe = [ { topic: topicNames[0], partition: 0, offset: -1 } ]
                assert.equal(
                    assignments.length,
                    shouldBe.length,
                    `${shouldBe.length} topic partitions should be assigned, got ${assignments.length}`
                );
                assert.topicOffsetsInAssignments(assignments, shouldBe);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should subscribe to a multiple allowed topics', (done) => {
        const client = createClient(restrictiveServerPort);
        client.on('ready', (availableTopics) => {
            client.emitAsync('subscribe', [topicNames[0], topicNames[1]])
            .then((assignments) => {
                let shouldBe = [
                    { topic: topicNames[0], partition: 0, offset: -1 },
                    { topic: topicNames[1], partition: 0, offset: -1 }
                ]
                assert.equal(
                    assignments.length,
                    shouldBe.length,
                    `${shouldBe.length} topic partitions should be assigned, got ${assignments.length}`
                );
                assert.topicOffsetsInAssignments(assignments, shouldBe);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should fail subscribe to a single unallowed topic', (done) => {
        const client = createClient(restrictiveServerPort);
        client.on('ready', (availableTopics) => {
            client.emitAsync('subscribe', ['non-existent-topic'])
            .catch((e) => {
                assert.errorNameEqual(e, 'TopicNotAvailableError');
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should fail subscribe to a multiple topics with at least one not allowed', (done) => {
        const client = createClient(restrictiveServerPort);
        client.on('ready', (availableTopics) => {
            client.emitAsync('subscribe', [topicNames[0], 'non-existent-topic'])
            .catch((e) => {
                // TODO check err type?
                assert.ok(true, 'should throw an error');
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should fail subscribe if already subscribed', (done) => {
        const client = createClient(serverPort);

        client.on('ready', () => {
            client.emitAsync('subscribe', topicNames[0])
            .then((subscribedTopics) => {
                // start consuming, the on message handler will collect them
                return client.emitAsync('subscribe', topicNames[1]);
            })
            .catch((e) => {
                assert.errorNameEqual(e, 'AlreadySubscribedError');
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });


    // == Test subscribe with offset

    it('should subscribe with offsets to a single topic', (done) => {
        const client = createClient(serverPort);
        const assignment = [ { topic: topicNames[0], partition: 0, offset: 0 } ];

        client.on('ready', (availableTopics) => {
            client.emitAsync('subscribe', assignment)
            .then((returnedAssignment) => {
                assert.equal(
                    returnedAssignment.length,
                    assignment.length,
                    `${assignment.length} topic partitions should be assigned`
                );
                assert.topicOffsetsInAssignments(returnedAssignment, assignment);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should subscribe with offsets to a single allowed topic', (done) => {
        const client = createClient(restrictiveServerPort);
        const assignment = [ { topic: topicNames[0], partition: 0, offset: 0 } ];

        client.on('ready', (availableTopics) => {
            client.emitAsync('subscribe', assignment)
            .then((returnedAssignment) => {
                assert.equal(
                    returnedAssignment.length,
                    assignment.length,
                    `${assignment.length} topic partitions should be assigned`
                );
                assert.topicOffsetsInAssignments(returnedAssignment, assignment);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should fail subscribe with offsets to a single not available topic', (done) => {
        const client = createClient(serverPort);
        const assignment = [ { topic: 'not-a-topic', partition: 0, offset: 0 } ];

        client.on('ready', (availableTopics) => {
            client.emitAsync('subscribe', assignment)
            .catch((e) => {
                // TODO check err type?
                assert.ok(true, 'should throw an error');
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should fail subscribe with offsets to a single not allowed topic', (done) => {
        const client = createClient(restrictiveServerPort);
        const assignment = [ { topic: 'kasocki_test_04', partition: 0, offset: 0 } ];

        client.on('ready', (availableTopics) => {
            client.emitAsync('subscribe', assignment)
            .catch((e) => {
                assert.errorNameEqual(e, 'TopicNotAvailableError');
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should subscribe with offsets to a multiple topics', (done) => {
        const client = createClient(serverPort);
        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
            { topic: topicNames[1], partition: 0, offset: 0 }
        ];

        client.on('ready', (availableTopics) => {
            client.emitAsync('subscribe', assignment)
            .then((returnedAssignment) => {
                assert.equal(
                    returnedAssignment.length,
                    assignment.length,
                    `${assignment.length} topic partitions should be assigned`
                );
                assert.topicOffsetsInAssignments(returnedAssignment, assignment);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });


    it('should fail subscribe with offsets to a multiple topics where one is not available', (done) => {
        const client = createClient(serverPort);
        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
            { topic: 'not-a-topic', partition: 0, offset: 0 }
        ];

        client.on('ready', (availableTopics) => {
            client.emitAsync('subscribe', assignment)
            .catch((e) => {
                assert.errorNameEqual(e, 'TopicNotAvailableError');
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    // == Test error socket event ==

    it('should fail consume if not yet subscribed and emit error event', (done) => {
        const client = createClient(serverPort);

        client.on('ready', (availableTopics) => {
            client.on('err', (e) => {
                assert.errorNameEqual(e, 'NotSubscribedError');
                client.disconnect();
                done();
            });

            // consume without subscribe
            client.emitAsync('consume', null)
            .then(() => {
                // should not get here!
                assert.ok(false, 'unsubscribed consume must error')
            })
            .catch((e) => {
                // no op, we will expect on error handler to validate error
            })
        })
    });


    // == Test consume ==

    it('should consume a single message from a single topic', (done) => {
        const client = createClient(serverPort);
        const assignment = [{ topic: topicNames[0], partition: 0, offset: 0 }];

        client.on('ready', (availableTopics) => {
            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                // consume
                return client.emitAsync('consume', null)
            })
            .then((msg) => {
                assert.equal(msg._kafka.offset, 0, `check kafka offset in ${topicNames[0]}`);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        })
    });

    it('should consume two messages from a single topic', (done) => {
        const client = createClient(serverPort);
        const assignment = [{ topic: topicNames[1], partition: 0, offset: 0 }];

        client.on('ready', () => {
            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                // consume
                return client.emitAsync('consume', null)
            })
            .then((msg) => {
                assert.equal(msg._kafka.offset, 0, `check kafka offset in ${topicNames[0]}`);
                // consume again
                return client.emitAsync('consume', null)
            })
            .then((msg) => {
                assert.equal(msg._kafka.offset, 1, `check kafka offset in ${topicNames[0]}`);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should consume three messages from two topics', (done) => {
        const client = createClient(serverPort);
        client.on('ready', () => {
            const assignment = [
                { topic: topicNames[0], partition: 0, offset: 0 },
                { topic: topicNames[1], partition: 0, offset: 0 }
            ];
            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                // Consume three messages
                return Promise.all([
                    client.emitAsync('consume', null),
                    client.emitAsync('consume', null),
                    client.emitAsync('consume', null)
                ]);
            })
            .then((messages) => {
                // Look for each of the following topic and offsets
                // to have been consumed.
                let shouldHave = [
                    { topic: topicNames[0], offset: 0 },
                    { topic: topicNames[1], offset: 0 },
                    { topic: topicNames[1], offset: 1 }
                ]
                assert.equal(messages.length, shouldHave.length, `should have consumed ${shouldHave.length} messages`);
                assert.topicOffsetsInMessages(messages, shouldHave);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should fail consume if not yet subscribed', (done) => {
        const client = createClient(serverPort);

        client.on('ready', (availableTopics) => {
            client.emitAsync('consume', null)
            .then(() => {
                // should not get here!
                assert.ok(false, 'unsubscribed consume must error')
            })
            .catch((e) => {
                assert.errorNameEqual(e, 'NotSubscribedError');
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        })
    });

    it('should not fail consume if a topic has bad data', (done) => {
        const client = createClient(serverPort);
        // topicNames[2] has invalid json at offset 0
        const assignment = [{ topic: topicNames[2], partition: 0, offset: 0 }];

        client.on('ready', (availableTopics) => {
            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                // consume
                return client.emitAsync('consume', null);
            })
            .then((msg) => {
                // The first message in topicNames[2] (kasocki_test_03)
                // should be skipped because it is not valid JSON,
                // and the next one should be returned to the client
                // transparently.
                assert.equal(msg._kafka.offset, 1, `check kafka offset in ${topicNames[0]}`);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        })
    });

    it('should subscribe and consume with offset reset to latest', (done) => {
        // Since we will produce data to kasocki_test_04, it is reserved for
        // this test only.
        const topicName = 'kasocki_test_04';

        const kafka = require('node-rdkafka');
        var producer = new kafka.Producer({
          'metadata.broker.list': 'localhost:9092',
        });
        producer = P.promisifyAll(producer, {});

        // Just fail if we encounter any producer errors.
        producer.on('error', (e) => {
            console.log(e);
            throw Error(`Kafka producer threw error: ${e.message}`);
        });

        producer.connectAsync(undefined)
        .then(() => {
            const topic = producer.Topic(topicName, {'request.required.acks': 1});

            const client = createClient(serverPort);
            const assignment = [ { topic: topicName, partition: 0, offset: 99999999999 } ];

            client.on('ready', (availableTopics) => {
                client.emitAsync('subscribe', assignment)
                .then((returnedAssignment) => {
                    // We need to interleave a consume and a produce call.
                    // The consume must happen first, so that the non-existent
                    // offset can be requested and reset.  Then, a message
                    // needs to be produced to the topic.  The consume
                    // call should pick up this message.

                    // attempt to consume, but don't return the promise yet.
                    let consumePromise = client.emitAsync('consume', null);

                    // Delay for a bit to make sure the consume request
                    //  has time to make it to Kafka.
                    return P.delay(3000)
                    // Then produce a message;
                    .then(() => {
                        return producer.produceAsync({
                            message: new Buffer('{"a": "new message"}'),
                            partition: 0,
                            topic: topic
                        })
                    })
                    // Once the message has been produced, return the
                    // consumePromise and wait for it to be resolved.
                    .then(() => {
                        return consumePromise;
                    });
                })
                .then((msg) => {
                    // fixture_kafka.sh should have set up 2 messages in kasocki_test_04.
                    // Since we produced 1 more message, we should have consumed the 3rd message at offset 2.
                    assert.equal(msg._kafka.offset, 2, `offset should have reset to latest in ${topicName}`);
                })
                .then(done)
                .catch(e => { done(e) })
                .finally(() => { client.disconnect() });
            });
        });
    });

    it('should subscribe and consume with offset reset to earliest', (done) => {
        const earliestServerPort = 6905;
        const earliestServer = new TestKasockiServer(earliestServerPort, {
            kafkaConfig: {
                default_topic_config: {
                    'auto.offset.reset': 'earliest'
                }
            }
        });
        earliestServer.listen();

        const client = createClient(earliestServerPort);
        const assignment = [ { topic: topicNames[0], partition: 0, offset: 999999999 } ];

        client.on('ready', (availableTopics) => {
            client.emitAsync('subscribe', assignment)
            .then((returnedAssignment) => {
                // consume
                return client.emitAsync('consume', null);
            })
            .then((msg) => {
                assert.equal(msg._kafka.offset, 0, `offset should have reset to earliest in ${topicNames[1]}`);
            })
            .then(done, (e) => { done(e) })
            .finally(() => {
                client.disconnect();
                earliestServer.close();
            });
        });
    });


    // == Test filter ==

    it('should consume two messages from two topics with a simple filter', (done) => {
        const client = createClient(serverPort);

        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
            { topic: topicNames[1], partition: 0, offset: 0 }
        ];

        // Filter where price is 25.00
        const filters = {
            'price': 25.00
        }

        client.on('ready', () => {

            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                return client.emitAsync('filter', filters)
            })
            .then(() => {
                // Consume two messages
                return Promise.all([
                    client.emitAsync('consume', null),
                    client.emitAsync('consume', null)
                ]);
            })
            .then((messages) => {
                // Look for each of the following topic and offsets
                // to have been consumed.
                let shouldHave = [
                    { topic: topicNames[0], offset: 0 },
                    { topic: topicNames[1], offset: 1 }
                ]
                assert.equal(messages.length, shouldHave.length, `should have consumed ${shouldHave.length} messages`);
                assert.topicOffsetsInMessages(messages, shouldHave);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should consume two messages from two topics with a dotted filter', (done) => {
        const client = createClient(serverPort);

        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
            { topic: topicNames[1], partition: 0, offset: 0 }
        ];

        // Filter where user.last_name is Berry
        const filters = {
            'user.last_name': 'Berry'
        }

        client.on('ready', () => {
            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                return client.emitAsync('filter', filters)
            })
            .then((r) => {
                // Consume two messages
                return Promise.all([
                    client.emitAsync('consume', null),
                    client.emitAsync('consume', null)
                ]);
            })
            .then((messages) => {
                // Look for each of the following topic and offsets
                // to have been consumed.
                let shouldHave = [
                    { topic: topicNames[0], offset: 0 },
                    { topic: topicNames[1], offset: 0 }
                ]
                assert.equal(messages.length, shouldHave.length, `should have consumed ${shouldHave.length} messages`);
                assert.topicOffsetsInMessages(messages, shouldHave);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should consume two messages from two topics with a regex filter', (done) => {
        const client = createClient(serverPort);

        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
            { topic: topicNames[1], partition: 0, offset: 0 }
        ];

        // Filter where name matches a regex
        const filters = {
            'name': '/(green|red) doors?$/'
        }

        client.on('ready', () => {
            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                return client.emitAsync('filter', filters)
            })
            .then((filters) => {
                // Consume two messages
                return Promise.all([
                    client.emitAsync('consume', null),
                    client.emitAsync('consume', null)
                ]);
            })
            .then((messages) => {
                // Look for each of the following topic and offsets
                // to have been consumed.
                let shouldHave = [
                    { topic: topicNames[1], offset: 0 },
                    { topic: topicNames[1], offset: 1 }
                ];
                assert.equal(messages.length, shouldHave.length, `should have consumed ${shouldHave.length} messages`);
                assert.topicOffsetsInMessages(messages, shouldHave);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should consume one message from two topics with a dotted and a regex filter', (done) => {
        const client = createClient(serverPort);

        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
            { topic: topicNames[1], partition: 0, offset: 0 }
        ];

        // Filter where user.last_name is Berry and name matches a regex
        const filters = {
            'user.last_name': 'Berry',
            'name': '/(green|red) doors?$/'
        }

        client.on('ready', () => {
            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                return client.emitAsync('filter', filters)
            })
            .then(() => {
                // consume one message
                return client.emitAsync('consume', null)
            })
            .then((msg) => {
                // Look for each of the following topic and offsets
                // to have been consumed.
                let shouldHave = [
                    { topic: topicNames[1], offset: 0 },
                ];
                assert.topicOffsetsInMessages([msg], shouldHave);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should fail filter with just a string', (done) => {
        const client = createClient(serverPort);

        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
            { topic: topicNames[1], partition: 0, offset: 0 }
        ];

        // invalid filters, not an object
        const filters = 'this will fail';

        client.on('ready', () => {
            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                return client.emitAsync('filter', filters)
            })
            .catch((e) => {
                assert.errorNameEqual(e, 'InvalidFilterError');
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should fail filter with an object filter', (done) => {
        const client = createClient(serverPort);

        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
            { topic: topicNames[1], partition: 0, offset: 0 }
        ];

        // Filter where name matches a bad regex
        const filters = {
            'name': {'this will': 'fail'}
        }

        client.on('ready', () => {
            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                return client.emitAsync('filter', filters)
            })
            .catch((e) => {
                assert.errorNameEqual(e, 'InvalidFilterError');
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should fail filter with a bad regex', (done) => {
        const client = createClient(serverPort);

        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
            { topic: topicNames[1], partition: 0, offset: 0 }
        ];

        // Filter where name matches a bad regex
        const filters = {
            'name': '/(green|red doors?$/'
        }

        client.on('ready', () => {
            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                return client.emitAsync('filter', filters)
            })
            .catch((e) => {
                assert.errorNameEqual(e, 'InvalidFilterError');
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should fail filter with an unsafe regex', (done) => {
        const client = createClient(serverPort);

        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
            { topic: topicNames[1], partition: 0, offset: 0 }
        ];

        // Filter where name matches a bad regex
        const filters = {
            'name': '/(a+){10}/'
        }

        client.on('ready', () => {
            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                return client.emitAsync('filter', filters)
            })
            .catch((e) => {
                assert.errorNameEqual(e, 'InvalidFilterError');
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should reset filters', (done) => {
        const client = createClient(serverPort);

        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
            { topic: topicNames[1], partition: 0, offset: 0 }
        ];

        // Filter where price is 25.00
        const filters = {
            'price': 25.00
        }

        client.on('ready', () => {

            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                return client.emitAsync('filter', filters)
            })
            .then((returnedFilters) => {
                return client.emitAsync('filter', undefined);
            })
            .then((returnedFilters) => {
                assert.equal(returnedFilters, undefined, 'filters should be reset to undefined');
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should consume two messages from two topics with an array filter against an array subject', (done) => {
        const client = createClient(serverPort);

        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
            { topic: topicNames[1], partition: 0, offset: 0 }
        ];

        // Filter where tags has both door and product
        const filters = {
            'tags': ['door', 'product']
        };

        client.on('ready', () => {

            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                return client.emitAsync('filter', filters)
            })
            .then(() => {
                // Consume two messages
                return Promise.all([
                    client.emitAsync('consume', null),
                    client.emitAsync('consume', null)
                ]);
            })
            .then((messages) => {
                // Look for each of the following topic and offsets
                // to have been consumed.
                let shouldHave = [
                    { topic: topicNames[1], offset: 0 },
                    { topic: topicNames[1], offset: 1 }
                ];
                assert.equal(messages.length, shouldHave.length, `should have consumed ${shouldHave.length} messages`);
                assert.topicOffsetsInMessages(messages, shouldHave);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should consume three messages from two topics with an array filter against a value subject', (done) => {
        const client = createClient(serverPort);

        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
            { topic: topicNames[1], partition: 0, offset: 0 }
        ];

        // Filter where price is 12.50 or 25.00
        const filters = {
            'price': [12.50, 25.00]
        };

        client.on('ready', () => {

            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                return client.emitAsync('filter', filters)
            })
            .then(() => {
                // Consume three messages
                return Promise.all([
                    client.emitAsync('consume', null),
                    client.emitAsync('consume', null),
                    client.emitAsync('consume', null)
                ]);
            })
            .then((messages) => {
                // Look for each of the following topic and offsets
                // to have been consumed.
                let shouldHave = [
                    { topic: topicNames[0], offset: 0 },
                    { topic: topicNames[1], offset: 0 },
                    { topic: topicNames[1], offset: 1 }
                ];
                assert.equal(messages.length, shouldHave.length, `should have consumed ${shouldHave.length} messages`);
                assert.topicOffsetsInMessages(messages, shouldHave);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });


    // == Test push based consume with start

    it('should handle three messages from two topics', (done) => {
        const client = createClient(serverPort);

        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
            { topic: topicNames[1], partition: 0, offset: 0 }
        ];

        // Collect messages
        var messages = [];
        client.on('message', (msg) => {
            messages.push(msg);
        });

        client.on('ready', () => {
            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                // start consuming, the on message handler will collect them
                return client.emitAsync('start', null);
            })
            // wait 3 seconds to finish getting messages
            .delay(3000)
            .then(() => {
                // Look for each of the following topic and offsets
                // to have been consumed.
                let shouldHave = [
                    { topic: topicNames[0], offset: 0 },
                    { topic: topicNames[1], offset: 0 },
                    { topic: topicNames[1], offset: 1 }
                ]
                assert.equal(messages.length, shouldHave.length, `should have consumed ${shouldHave.length} messages, but consumed ${messages.length}`);
                assert.topicOffsetsInMessages(messages, shouldHave);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });


    it('should handle one message from two topics with a dotted and a regex filter', (done) => {
        const client = createClient(serverPort);

        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
            { topic: topicNames[1], partition: 0, offset: 0 }
        ];

        // Filter where user.last_name is Berry and name matches a regex
        const filters = {
            'user.last_name': 'Berry',
            'name': '/(green|red) doors?$/'
        }

        // Collect messages
        var messages = [];
        client.on('message', (msg) => {
            messages.push(msg);
        });

        client.on('ready', () => {
            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                return client.emitAsync('filter', filters)
            })
            .then(() => {
                // start consuming, the on message handler will collect them
                return client.emitAsync('start', null);
            })
            // wait 3 seconds to finish getting messages
            .delay(3000)
            .then(() => {
                // Look for each of the following topic and offsets
                // to have been consumed.
                let shouldHave = [
                    { topic: topicNames[1], offset: 0 },
                ]
                assert.equal(messages.length, shouldHave.length, `should have consumed ${shouldHave.length} messages, but consumed ${messages.length}`);
                assert.topicOffsetsInMessages(messages, shouldHave);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should fail start if not yet subscribed', (done) => {
        const client = createClient(serverPort);

        client.on('ready', (availableTopics) => {
            client.emitAsync('start', null)
            .then(() => {
                // should not get here!
                assert.ok(false, 'unsubscribed consume must error')
            })
            .catch((e) => {
                assert.errorNameEqual(e, 'NotSubscribedError');
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        })
    });

    it('should fail start if already started', (done) => {
        const client = createClient(serverPort);

        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
        ];

        client.on('ready', () => {
            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                client.emitAsync('start', null);
            })
            .then(() => {
                // call start again
                client.emitAsync('start', null);
            })
            .catch((e) => {
                assert.errorNameEqual(e, 'AlreadyStartedError');
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should fail start if already started and handle an err socket event', (done) => {
        const client = createClient(serverPort);

        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
        ];

        client.on('ready', () => {
            client.on('err', (e) => {
                assert.errorNameEqual(e, 'AlreadyStartedError');
            });

            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                client.emitAsync('start', null);
            })
            .then(() => {
                // call start again
                client.emitAsync('start', null);
            })
            .catch((e) => {
                // do nothing, we will check that the err socket event
                // handler gets the error.
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });


    // == Test stop ==

    it('should do nothing if stopped before started', (done) => {
        const client = createClient(serverPort);

        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
            { topic: topicNames[1], partition: 0, offset: 0 }
        ];

        client.on('ready', () => {
            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                // start consuming, the on message handler will collect them
                client.emitAsync('stop', null);
            })
            // Stop and assert that nothing bad happened.
            .then(() => {
                assert.ok(true);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });

    it('should handle three messages from two topics with stop and resume', (done) => {
        const client = createClient(serverPort);

        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
            { topic: topicNames[1], partition: 0, offset: 0 }
        ];

        // Collect messages
        var messages = [];
        client.on('message', (msg) => {
            messages.push(msg);
        });

        client.on('ready', () => {
            client.emitAsync('subscribe', assignment)
            .then((subscribedTopics) => {
                // start consuming, the on message handler will collect them
                client.emitAsync('start', null);
            })
            // Stop as soon as possible.
            .then(() => {
                client.emitAsync('stop', null);
            })
            // wait 1 seconds before resuming
            .delay(1000)
            // then resume
            .then(() => {
                return client.emitAsync('start', null);
            })
            // wait 3 seconds to finish getting messages
            .delay(3000)
            .then(() => {
                // Look for each of the following topic and offsets
                // to have been consumed.
                let shouldHave = [
                    { topic: topicNames[0], offset: 0 },
                    { topic: topicNames[1], offset: 0 },
                    { topic: topicNames[1], offset: 1 }
                ]
                assert.equal(messages.length, shouldHave.length, `should have consumed ${shouldHave.length} messages, but consumed ${messages.length}`);
                assert.topicOffsetsInMessages(messages, shouldHave);
            })
            .then(done, (e) => { done(e) })
            .finally(() => { client.disconnect() });
        });
    });


    // == Test custom message deserializer

    it('should take a custom message deserializer and use it', (done) => {

        const shouldBe = {'i am': 'not a good deserializer'}

        // create a custom Kasocki server with a custom message deserializer
        // for this test.
        const customDeserializingServerPort = 6092;
        const customDeserializingServer = new TestKasockiServer(
            customDeserializingServerPort,
            {
                // configure this Kasocki server with a pretty useless
                // message deserializer function, just for testing this feature.
                deserializer: function(kafkaMessage) {
                    return shouldBe;
                }
            }
        );
        customDeserializingServer.listen();

        const client = createClient(customDeserializingServerPort);

        const assignment = [
            { topic: topicNames[0], partition: 0, offset: 0 },
        ];

        client.on('ready', () => {
            client.emitAsync('subscribe', assignment)
            .then(() => {
                client.emitAsync('consume', undefined)
                .then((msg) => {
                    assert.deepEqual(msg, shouldBe, 'should custom deserialize message');
                })
                .then(done, (e) => { done(e) })
                .finally(() => {
                    client.disconnect();
                    customDeserializingServer.close();
                })
            })
        })
    });

    it('should not throw error to client for deserialization error', (done) => {
        // create a custom Kasocki server with a custom message deserializer
        // for this test.
        const customDeserializingServerPort = 6093;
        const customDeserializingServer = new TestKasockiServer(
            customDeserializingServerPort,
            {
                // configure this Kasocki server with a pretty useless
                // message deserializer function, just for testing this feature.
                deserializer: function(kafkaMessage) {
                    // throw an error the first time the message is called.
                    if (kafkaMessage.offset === 0) {
                        throw new Error('Client should not see this');
                    }
                    // else just return something we can check
                    else {
                        return {offset: kafkaMessage.offset};
                    }
                }
            }
        );
        customDeserializingServer.listen();

        const client = createClient(customDeserializingServerPort);

        const assignment = [
            { topic: topicNames[1], partition: 0, offset: 0 },
        ];

        client.on('ready', () => {
            client.emitAsync('subscribe', assignment)
            .then(() => {
                client.emitAsync('consume', undefined)
                .then((msg) => {
                    // offset 0 should have been skipped because of the
                    // Error thrown when offset === 0 by the deserializer.
                    assert.deepEqual(msg, {'offset': 1}, 'should skip first message because of DeserializationError');
                })
                .then(done, (e) => { done(e) })
                .finally(() => {
                    client.disconnect();
                    customDeserializingServer.close();
                })
            })
        })
    });

});
