const url = require('url');
const tcp = require('net');
const util = require('util');
const ssdp = require('ssdp2');
const EventEmitter = require('events');

/**
 * debug
 */
console.debug = util.debuglog('yeelight');

/**
 * [Yeelight description]
 * @docs http://www.yeelight.com/download/Yeelight_Inter-Operation_Spec.pdf
 */
function Yeelight(address, port) {
  var u = url.parse(address);
  if (u.protocol === 'yeelight:') {
    address = u.hostname;
    port = u.port;
  }
  if (!(this instanceof Yeelight)) {
    console.debug('creating new instance of Yeelight with addr & port', address, port)
    return new Yeelight(address, port);
  }

  port = port || 55443;
  EventEmitter.call(this);
  this.queue = {};

  this.address = address;
  this.port = port;
  this.initSocket();

  return this;
};

/**
 * Yeelight extends EventEmitter
 */
util.inherits(Yeelight, EventEmitter);

/**
 * [discover description]
 * @return {[type]} [description]
 */
Yeelight.discover = function (port, callback) {
  if (typeof port === 'function') {
    callback = port;
    port = 1982;
  }
  var yeelights = [];
  var discover = ssdp({
    port: port || 1982
  });
  discover.on('response', function (response) {
    var address = response.headers['Location'];
    console.debug('received response from', address);
    if (address && (!~yeelights.indexOf(address))) {
      yeelights.push(address);
      var yeelight = new Yeelight(address);
      yeelight.id = response.headers.id;
      yeelight.on('connect', function () {
        callback.call(discover, this, response);
      });
    };

  });
  console.debug('start finding ...');
  return discover.search('wifi_bulb');
};

/**
 * [props description]
 * @type {String}
 */
Yeelight.prototype.props = [
  "name", "power", "bright", "rgb",
  "ct", "hue", "sat", "color_mode",
  "delayoff", "flowing", "flow_params",
  "music_on"
];

/**
 *[checkSocket description]
 * @return {[type]} [description]
 */
Yeelight.prototype.initSocket = function () {
  var buffer = '';
  this.socket = new tcp.Socket();
  // this.socket.setTimeout(2000);
  this.socket.setKeepAlive(true);
  this.socket
    .on('data', function (chunk) {
      buffer += chunk;
      buffer.split(/\r\n/g).filter(function (line) {
        return !!line;
      }).forEach(this.parse.bind(this));
      buffer = '';
    }.bind(this))
    .on('timeout', function () {
      this.connected = false;
      this.socket.end();
      this.emit('timeout', this);
      this.emit('disconnect', this);
    }.bind(this))
    .on('error', function (err) {
      this.connected = false;
      this.socket.end();
      this.emit('error', err);
      this.emit('disconnect', this);
    }.bind(this))
    .on('end', function () {
      this.connected = false;
      this.emit('disconnect', this);
    }.bind(this))
    .connect(this.port, this.address, function (err) {
      this.connected = true;
      this.sync().then(function () {
        this.emit('connect', this);
      }.bind(this));
    }.bind(this));
};

/**
 *[checkSocket description]
 * @return {[type]} [description]
 */
Yeelight.prototype.checkSocket = function () {
  if (!this.socket.destroyed) {
    return;
  }

  this.socket.end();
  this.socket = null;

  this.initSocket();
};

/**
 * [sync description]
 * @return {[type]} [description]
 */
Yeelight.prototype.sync = function () {
  return this.get_prop.apply(this, this.props)
    .then(function (res) {
      if (!res) {
        return {};
      }

      Object.keys(res).forEach(function (key) {
        this[key] = res[key];
      }.bind(this));
      return res;
    }.bind(this));
};

/**
 * [parse description]
 * @param  {[type]} data [description]
 * @return {[type]}      [description]
 */
Yeelight.prototype.parse = function (data) {
  console.debug('->', data);
  var yl = this;

  function parseResult(result) {
    var message = JSON.parse(result);
    if (message.method === 'props') {
      Object.keys(message.params).forEach(function (key) {
        yl[key] = message.params[key];
      }.bind(yl));
    }
    yl.emit(message.method, message.params, message);
    if (typeof yl.queue[message.id] === 'function') {
      yl.queue[message.id](message);
      yl.queue[message.id] = null;
      delete yl.queue[message.id];
    }
  }
  var results = data.toString().replace("}{", "}}{{").split("}{");
  for (i = 0; i < results.length; i++) {
    parseResult(results[i]);
  }
};

/**
 * [command description]
 * @param  {[type]} method [description]
 * @param  {[type]} params [description]
 * @return {[type]}        [description]
 */
Yeelight.prototype.command = function (method, params) {
  params = [].slice.call(params || []);
  var id = (Math.random() * 1e3) & 0xff;
  var request = {
    id,
    method,
    params
  };
  var message = JSON.stringify(request);
  request.promise = new Promise((accept, reject) => {
    console.debug('<-', message);
    this.checkSocket();
    this.socket.write(message + '\r\n', err => {
      var respond = false;
      var timeout = setTimeout(function () {
        if (!respond) reject(new Error('Network timeout, Yeelight not response'));
      }, 3000);
      this.queue[id] = function (res) {
        if (respond) {
          console.log('>>>>>>>>>>>>>>>>>>>>>>>>>>>>> response = true');
          return;
        }
        respond = true;
        clearTimeout(timeout);
        var err = res.error;
        if (err) return reject(err);
        accept(res);
      };
    });
  });
  return request.promise;
};

/**
 * get_prop
 * This method is used to retrieve current property of smart LED.
 *
 * @params prop1..N The parameter is a list of property names and the response contains a
 * list of corresponding property values. If the requested property name is not recognized by
 * smart LED, then a empty string value ("") will be returned.
 *
 * @example
 *
 * Request:
 * {"id":1,"method":"get_prop","params":["power", "not_exist", "bright"]}
 *
 * Response:
 * {"id":1, "result":["on", "", "100"]}
 *
 * All the supported properties are defined in table 4-2, section 4.3
 *
 */
Yeelight.prototype.get_prop = function (prop1, prop2, propN) {
  var props = [].concat.apply([], arguments);
  return this.command('get_prop', props).then(function (res) {
    return props.reduce(function (item, name, index) {
      item[name] = res.result[index];
      return item;
    }, {});
  }).catch(err => {
    console.log('get_prop error: ' + err);
  });
};

/**
 * set_name This method is used to name the device. The name will be stored on the
 *          device and reported in discovering response.
 *          User can also read the name through “get_prop” method.
 * @param {[type]} name [description]
 */
Yeelight.prototype.set_name = function (name) {
  return this.command('set_name', [name]).catch(err => {
    console.log('set_name error: ' + err);
  });
};

/**
 * set_ct_abx
 * This method is used to change the color temperature of a smart LED
 *
 * @param ct_value is the target color temperature. The type is integer and
 *                 range is 1700 ~ 6500 (k).
 * @param effect support two values: "sudden" and "smooth". If effect is "sudden",
 *               then the color temperature will be changed directly to target value, under this case, the
 *               third parameter "duration" is ignored. If effect is "smooth", then the color temperature will
 *               be changed to target value in a gradual fashion, under this case, the total time of gradual
 *               change is specified in third parameter "duration".
 * @param duration specifies the total time of the gradual changing. The unit is
 *                 milliseconds. The minimum support duration is 30 milliseconds.
 */
Yeelight.prototype.set_ct_abx = function (ct_value, effect, duration) {
  ct_value = Math.max(1700, Math.min(+ct_value || 3500, 6500));
  return this.command('set_ct_abx', [ct_value, effect || 'smooth', duration || 500]).catch(err => {
    console.log('set_ct_abx error: ' + err);
  });
};

/**
 * set_rgb This method is used to change the color of a smart LED.
 * @param rgb_value is the target color, whose type is integer. It should be
 *                  expressed in decimal integer ranges from 0 to 16777215 (hex: 0xFFFFFF).
 * @param {[type]} effect    [Refer to "set_ct_abx" method.]
 * @param {[type]} duration  [Refer to "set_ct_abx" method.]
 */
Yeelight.prototype.set_rgb = function (rgb_value, effect, duration) {
  rgb_value = Math.max(0, Math.min(+rgb_value, 0xffffff));
  return this.command('set_rgb', [rgb_value, effect || 'smooth', duration || 500]).catch(err => {
    console.log('set_rgb error: ' + err);
  });
};

/**
 * [set_hsv This method is used to change the color of a smart LED]
 * @param {[type]} hue is the target hue value, whose type is integer.
 *                 It should be expressed in decimal integer ranges from 0 to 359.
 * @param {[type]} sat is the target saturation value whose type is integer. It's range is 0 to 100
 * @param {[type]} effect   [Refer to "set_ct_abx" method.]
 * @param {[type]} duration [Refer to "set_ct_abx" method.]
 */
Yeelight.prototype.set_hsv = function (hue, sat, effect, duration) {
  hue = Math.max(0, Math.min(+hue, 359));
  sat = Math.max(0, Math.min(+sat, 100));
  return this.command('set_hsv', [hue, sat, effect || 'smooth', duration || 500]).catch(err => {
    console.log('set_hsv error: ' + err);
  });
};

/**
 * [set_bright This method is used to change the brightness of a smart LED.]
 * @param brightness is the target brightness. The type is integer and ranges
 *                   from 1 to 100. The brightness is a percentage instead of a absolute value.
 *                   100 means maximum brightness while 1 means the minimum brightness.
 * @param {[type]} effect     [Refer to "set_ct_abx" method.]
 * @param {[type]} duration   [Refer to "set_ct_abx" method.]
 */
Yeelight.prototype.set_bright = function (brightness, effect, duration) {
  brightness = Math.max(1, Math.min(+brightness, 100));
  return this.command('set_bright', [brightness, effect || 'smooth', duration || 500]).catch(err => {
    console.log('set_bright error: ' + err);
  });
};

/**
 * set_power This method is used to switch on or off the smart LED (software
 *           managed on/off).
 * @param {[type]} power can only be "on" or "off".
 *                 "on"  means turn on the smart LED,
 *                 "off" means turn off the smart LED.
 * @param {[type]} effect   [description]
 * @param {[type]} duration [description]
 */
Yeelight.prototype.set_power = function (power, effect, duration) {
  power = ~[1, true, '1', 'on'].indexOf(power) ? 'on' : 'off';
  return this.command('set_power', [power, effect || 'smooth', duration || 500]).catch(err => {
    console.log('set_power error: ' + err);
  });
};

/**
 * [toggle This method is used to toggle the smart LED.]
 * @return {[type]} [description]
 */
Yeelight.prototype.toggle = function () {
  return this.command('toggle').catch(err => {
    console.log('toggle error: ' + err);
  });
};

/**
 * [set_default This method is used to save current state of smart LED in persistent
 *              memory. So if user powers off and then powers on the smart LED again (hard power reset),
 *              the smart LED will show last saved state.]
 */
Yeelight.prototype.set_default = function () {
  return this.command('set_default', arguments).catch(err => {
    console.log('set_default error: ' + err);
  });
};

Yeelight.prototype.start_cf = function (count, action, flow_expression) {
  return this.command('start_cf', arguments).catch(err => {
    console.log('set_cf error: ' + err);
  });
};
/**
 * [stop_cf This method is used to stop a running color flow.]
 * @return {[type]} [description]
 */
Yeelight.prototype.stop_cf = function () {
  return this.command('stop_cf').catch(err => {
    console.log('stop_cf error: ' + err);
  });
};
/**
 * set_scene This method is used to set the smart LED directly to specified state. If
 *           the smart LED is off, then it will turn on the smart LED firstly and then apply the specified
 *           command.
 */
Yeelight.prototype.set_scene = function (type) {
  return this.command('set_scene', arguments).catch(err => {
    console.log('set_scene error: ' + err);
  });
};
/**
 * [cron_add description]
 * @param  {[type]} type  [description]
 * @param  {[type]} value [description]
 * @return {[type]}       [description]
 */
Yeelight.prototype.cron_add = function (type, value) {
  return this.command('cron_add', arguments).catch(err => {
    console.log('cron_add error: ' + err);
  });
};
/**
 * [cron_get description]
 * @param  {[type]} type [description]
 * @return {[type]}      [description]
 */
Yeelight.prototype.cron_get = function (type) {
  return this.command('cron_get', arguments).catch(err => {
    console.log('cron_get error: ' + err);
  });
};
/**
 * [cron_del description]
 * @param  {[type]} type [description]
 * @return {[type]}      [description]
 */
Yeelight.prototype.cron_del = function (type) {
  return this.command('cron_del', arguments).catch(err => {
    console.log('cron_del error: ' + err);
  });
};
/**
 * [set_adjust description]
 * @param {[type]} action [description]
 * @param {[type]} prop   [description]
 */
Yeelight.prototype.set_adjust = function (action, prop) {
  return this.command('set_adjust', [action, prop]).catch(err => {
    console.log('set_adjust error: ' + err);
  });
};
/**
 * [set_music description]
 * @param {[type]} action [description]
 * @param {[type]} host   [description]
 * @param {[type]} port   [description]
 */
Yeelight.prototype.set_music = function (action, host, port) {
  action = action & 0xff;
  return this.command('set_music', arguments).catch(err => {
    console.log('set_music error: ' + err);
  });
};

/**
 * [exit description]
 * @return {[type]} [description]
 */
Yeelight.prototype.exit = function () {
  this.socket.end();
  return this;
};

module.exports = Yeelight;