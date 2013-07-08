/**
 * This is a fairly real-world usage of Discover.
 *
 * In this example we setup three interconnected services, which will
 * communicate via RabbitMQ, and run the initial service discovery through
 * Discover. The master, in this case, is a service dedicated to the well-being
 * of the message queue, and it along holds the keys to the queue, which the
 * service distributes via Discover.
 *
 * See also: service-*.js
 */

var discovery = require('./service-discovery');
var _ = require('underscore');
var fs = require('fs');
var path = require('path');
var mq = require('amqp');
var db = require('redis');
var EventEmitter = require('events').EventEmitter;

var redis, rabbit;
var register, creation;
var emitter = new EventEmitter();

discovery.advertise({
  type: 'service.web',
  ready: false
});

discovery.mandate('configure.rabbit');

discovery.service('service.queue', function(service) {
  rabbit = mq.createConnection(service.config);
  rabbit.on('ready', function() {
    var done = _.after(2, discovery.fulfill('configure.rabbit'));
    var next = _.after(2, function() {
      creation.bind(exchange, '');
      creation.subscribe({ack: false, prefetchCount: 0}, emitter.emit.bind(emit, 'create'));
      done();
    });
    // for incoming data stream
    var exchange = rabbit.exchange('service-create', {autoDelete: false, type: 'fanout'}, next);
    creation = rabbit.queue('', {exclusive: true}, next);
    // for outgoing registrations
    register = rabbit.exchange('service-register', {durable: true, confirm: true, autoDelete: false, type: 'fanout'}, done);
  });
  rabbit.on('error', console.log.bind(console));
});

discovery.service('service.data.redis', function(service) {
  redis = db.createClient(service.config.port, service.config.host);
  if (service.config.auth)
    redis.auth(service.config.auth, discovery.fulfill('redis'));
});

discovery.ready(function() {
  // services discovered and ready
  // listen for http requests
  server.listen(app.get('port'), function() {
    console.log('Web server listening on port ' + app.get('port'));
  });
  // now we're ready for connections
  discovery.advertise({
    type: 'service.web',
    port: app.get('port'),
    ready: true
  });
});

var express = require('express');
var http = require('http');

var app = express();
var server = http.createServer(app);

app.set('port', process.env.PORT || 3000);
app.disable('x-powered-by');
app.use(express.logger('dev'));
app.use(app.router);

app.get('/', function(req, res) {
  res.send('Welcome!');
});

app.post('/register', function(req, res) {
  // TODO: check registration requirements
  var data = new Buffer(JSON.stringify(req.body), 'utf8');
  register.publish('', data, {deliveryMode: 1, contentType: 'application/json', contentEncoding: 'utf8'});
  res.send('registration queued');
});

var streamHead = path.join(__dirname, 'service-web.html');

var json = function(obj) {
  return JSON.stringify(obj, null, 2)
    .replace('&', '&amp;')
    .replace('<', '&lt;')
    .replace('>', '&gt;')
    .replace('"', '&quot;')
    .replace("'", '&#x27;')
    .replace('/', '&#x2F;');
};

app.get('/stream', function(req, res) {
  res.type('text/html; charset=utf-8');
  var head = fs.createReadStream(streamHead);
  head.on('data', res.write.bind(res));
  head.on('end', function() {
    emitter.on('create', function(message, headers, deliveryInfo) {
      res.write(new Buffer('<h2>Register</h2>\n<pre>' + json(message) + '</pre>\n', 'utf-8'));
    });
  });
});

var dberr = {error: 1, errors: [{error: 4, message: 'database error'}]};

// TODO: LIMIT implementation?
app.get('/items', function(req, res) {
  redis.lrange('items', 0, -1, function(err, items) {
    if (err)
      return res.json(500, dberr);
    res.json({items: items});
  });
});

app.put('/items', function(req, res) {
  var index = req.get('x-index');
  var after = function(err, result) {
    if (err)
      return res.json(500, dberr);
    res.json({result: result});
  };
  if (index)
    redis.lset('items', index, req.body, after);
  else
    redis.rpush('items', req.body, after);
});

app.delete('/items', function(req, res) {
  var index = req.get('x-index');
  if (!index)
    return res.json(500, {error: 1, errors: [{error: 2, message: 'missing index header'}]});
  redis.lrem('items', 1, index, function(err, removed) {
    if (err)
      return res.json(500, dberr);
    res.json({removed: removed});
  });
});
