/**
 * Copyright 2015 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

require('dotenv').config({silent: true});

var express = require('express');  // app server
var bodyParser = require('body-parser');  // parser for post requests
var Watson = require('watson-developer-cloud/conversation/v1');  // watson sdk
var request = require('request')

// The following requires are needed for logging purposes
var uuid = require('uuid');
var vcapServices = require('vcap_services');
var basicAuth = require('basic-auth-connect');

// The app owner may optionally configure a cloudand db to track user input.
// This cloudand db is not required, the app will operate without it.
// If logging is enabled the app must also enable basic auth to secure logging
// endpoints
var cloudantCredentials = vcapServices.getCredentials('cloudantNoSQLDB');
var cloudantUrl = null;
if (cloudantCredentials) {
    cloudantUrl = cloudantCredentials.url;
}
cloudantUrl = cloudantUrl || process.env.CLOUDANT_URL; // || '<cloudant_url>';
var logs = null;
var app = express();

// Bootstrap application settings
app.use(express.static('./public')); // load UI from public folder
app.use(bodyParser.json());

// Create the service wrapper
var conversation = new Watson({
    // If unspecified here, the CONVERSATION_USERNAME and CONVERSATION_PASSWORD env properties will be checked
    // After that, the SDK will fall back to the bluemix-provided VCAP_SERVICES environment property
    // username: '<username>',
    // password: '<password>',
    url: 'https://gateway.watsonplatform.net/conversation/api',
    version_date: '2016-09-20',
    version: 'v1'
});

// Endpoint to be call from the client side
app.post('/api/message', function (req, res) {
    var workspace = process.env.WORKSPACE_ID || '<workspace-id>';

    if (!workspace || workspace === '<workspace-id>') {
        return res.json({
            'output': {
                'text': 'The app has not been configured with a <b>WORKSPACE_ID</b> environment variable. Please refer to the ' +
                '<a href="https://github.com/watson-developer-cloud/conversation-simple">README</a> documentation on how to set this variable. <br>' +
                'Once a workspace has been defined the intents may be imported from ' +
                '<a href="https://github.com/watson-developer-cloud/conversation-simple/blob/master/training/car_workspace.json">here</a> in order to get a working application.'
            }
        });
    }
    var payload = {
        workspace_id: workspace,
        context: {
            roomNumber: -1
        },
        input: {}
    };
    if (req.body) {
        if (req.body.input) {
            payload.input = req.body.input;
        }
        if (req.body.context) {
            // The client must maintain context/state
            payload.context = req.body.context;
        }
    }

    // INJECT VARIABLES INTO CONTEXT
    payload.context.currentTotal = 0;
    payload.context.numerOfPizzasInCart = 0;

    // Send the input to the conversation service
    conversation.message(payload, function (err, data) {
        // console.log('------p')
        // console.log(payload)
        // console.log('------')
        console.log(data);
        console.log('------')
        if (data.context.currentPizza != null) {
            console.log(data.context.currentPizza);
            addPizza(data.context.roomNumber, data.context.currentPizza);
            delete data.context["currentPizza"];
        }

        if (err) {
            return res.status(err.code || 500).json(err);
        }

        if (data.intents.length > 0) {
            // console.log(data.intents[0].intent)
            switch (data.intents[0].intent) {
                case "createRoom":
                    // if (data.context.wantToJoinRoom != null) {
                    //     data.context.roomNumber = data.context.wantToJoinRoom;
                    // }
                    // console.log("Joining Room")
                    // //res.json({"":""});
                    createRoom(function (id) {
                        data.context.roomNumber = id;
                        data.output.text = "I have created a room for with id:" + id;
                        console.log("Your Room id is now: " + id)
                        return res.json(updateMessage(payload, data));
                    })
                    break;
                case "currentList":
                    getRoomInfo(data.context.roomNumber, function (pizzas) {
                        var names = [];

                        for (var i = 0; i < pizzas.length; i++) {
                            names[i] = pizzas[i].details.name;
                        }
                        data.output.text = names.join("<br />");
                        return res.json(updateMessage(payload, data));
                    });
                    break;
                default:
                    if (err) {
                        return res.status(err.code || 500).json(err);
                    }
                    return res.json(updateMessage(payload, data));
                    break;

            }
        } else {
            return res.json(updateMessage(payload, data));
        }


    });
});

/**
 * Updates the response text using the intent confidence
 * @param  {Object} input The request to the Conversation service
 * @param  {Object} response The response from the Conversation service
 * @return {Object}          The response with the updated message
 */
function updateMessage(input, response) {
    var responseText = null;
    var id = null;
    if (!response.output) {
        response.output = {};
    } else {
        if (logs) {
            // If the logs db is set, then we want to record all input and responses
            id = uuid.v4();
            logs.insert({'_id': id, 'request': input, 'response': response, 'time': new Date()});
        }
        return response;
    }
    if (response.intents && response.intents[0]) {
        var intent = response.intents[0];
        // Depending on the confidence of the response the app can return different messages.
        // The confidence will vary depending on how well the system is trained. The service will always try to assign
        // a class/intent to the input. If the confidence is low, then it suggests the service is unsure of the
        // user's intent . In these cases it is usually best to return a disambiguation message
        // ('I did not understand your intent, please rephrase your question', etc..)
        if (intent.confidence >= 0.75) {
            responseText = 'I understood your intent was ' + intent.intent;
        } else if (intent.confidence >= 0.5) {
            responseText = 'I think your intent was ' + intent.intent;
        } else {
            responseText = 'I did not understand your intent';
        }
    }
    response.output.text = responseText;
    if (logs) {
        // If the logs db is set, then we want to record all input and responses
        id = uuid.v4();
        logs.insert({'_id': id, 'request': input, 'response': response, 'time': new Date()});
    }
    return response;
}

if (cloudantUrl) {
    // If logging has been enabled (as signalled by the presence of the cloudantUrl) then the
    // app developer must also specify a LOG_USER and LOG_PASS env vars.
    if (!process.env.LOG_USER || !process.env.LOG_PASS) {
        throw new Error('LOG_USER OR LOG_PASS not defined, both required to enable logging!');
    }
    // add basic auth to the endpoints to retrieve the logs!
    var auth = basicAuth(process.env.LOG_USER, process.env.LOG_PASS);
    // If the cloudantUrl has been configured then we will want to set up a nano client
    var nano = require('nano')(cloudantUrl);
    // add a new API which allows us to retrieve the logs (note this is not secure)
    nano.db.get('car_logs', function (err) {
        if (err) {
            console.error(err);
            nano.db.create('car_logs', function (errCreate) {
                console.error(errCreate);
                logs = nano.db.use('car_logs');
            });
        } else {
            logs = nano.db.use('car_logs');
        }
    });

    // Endpoint which allows deletion of db
    app.post('/clearDb', auth, function (req, res) {
        nano.db.destroy('car_logs', function () {
            nano.db.create('car_logs', function () {
                logs = nano.db.use('car_logs');
            });
        });
        return res.json({'message': 'Clearing db'});
    });

    // Endpoint which allows conversation logs to be fetched
    app.get('/chats', auth, function (req, res) {
        logs.list({include_docs: true, 'descending': true}, function (err, body) {
            console.error(err);
            // download as CSV
            var csv = [];
            csv.push(['Question', 'Intent', 'Confidence', 'Entity', 'Output', 'Time']);
            body.rows.sort(function (a, b) {
                if (a && b && a.doc && b.doc) {
                    var date1 = new Date(a.doc.time);
                    var date2 = new Date(b.doc.time);
                    var t1 = date1.getTime();
                    var t2 = date2.getTime();
                    var aGreaterThanB = t1 > t2;
                    var equal = t1 === t2;
                    if (aGreaterThanB) {
                        return 1;
                    }
                    return equal ? 0 : -1;
                }
            });
            body.rows.forEach(function (row) {
                var question = '';
                var intent = '';
                var confidence = 0;
                var time = '';
                var entity = '';
                var outputText = '';
                if (row.doc) {
                    var doc = row.doc;
                    if (doc.request && doc.request.input) {
                        question = doc.request.input.text;
                    }
                    if (doc.response) {
                        intent = '<no intent>';
                        if (doc.response.intents && doc.response.intents.length > 0) {
                            intent = doc.response.intents[0].intent;
                            confidence = doc.response.intents[0].confidence;
                        }
                        entity = '<no entity>';
                        if (doc.response.entities && doc.response.entities.length > 0) {
                            entity = doc.response.entities[0].entity + ' : ' + doc.response.entities[0].value;
                        }
                        outputText = '<no dialog>';
                        if (doc.response.output && doc.response.output.text) {
                            outputText = doc.response.output.text.join(' ');
                        }
                    }
                    time = new Date(doc.time).toLocaleString();
                }
                csv.push([question, intent, confidence, entity, outputText, time]);
            });
            res.csv(csv);
        });
    });
}

var PREFIX = "http://localhost:8080/api/v1/";
var CREATE_ROOM_ENDPOINT = PREFIX + "rooms";
var JOIN_ROOM_ENDPOINT = PREFIX + "room/";
var ADD_PIZZA_ENDPOINT_START = PREFIX + "room/";
var ADD_PIZZA_ENDPOINT_END = "/pizza";

function getRoomInfo(roomId, callback) {
    request.get(
        PREFIX + "/room/" + roomId,
        function (error, response, body) {
            console.log(error, response);
            if (!error && response.statusCode == 200) {
                console.log(body);
                body = JSON.parse(body);
                callback(body.pizzas);
            }
        }
    )
}

function createRoom(callback) {
    request
        .post(CREATE_ROOM_ENDPOINT, function (error, response, body) {
            console.log(error, body)
            if (!error && response.statusCode == 200) {
                var body = JSON.parse(body);
                console.log(body.id)
                callback(body.id)
            }
        })
}

function getRoomInfo(roomId, callback) {
    request.get(
        PREFIX + "/room/" + roomId,
        function (error, response, body) {
            console.log(error, response);
            if (!error && response.statusCode == 200) {
                console.log(body);
                body = JSON.parse(body);
                callback(body.pizzas);
            }
        }
    )
}

function addPizza(roomId, pizza, callback) {
    request(
        {
            url: ADD_PIZZA_ENDPOINT_START + roomId + ADD_PIZZA_ENDPOINT_END + "/" + pizza + "&4",
            method: "PUT"
        },
        function (error, response, body) {
            console.log(error, response);
            if (!error && response.statusCode == 200) {
                console.log(body);
                if (callback != null) {
                    callback();
                }
            }
        });
}

function deletePizza(roomId, pizza, callback) {
    request.delete(
        ADD_PIZZA_ENDPOINT_START + roomId + ADD_PIZZA_ENDPOINT_END + "/" + pizza + "&Pizza.25CM",
        function (error, response, body) {
            console.log(error, response);
            if (!error && response.statusCode == 200) {
                console.log(body);
                callback();
            }
        });
}

module.exports = app;
