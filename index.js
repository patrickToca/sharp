'use strict';

var path = require('path');
var util = require('util');
var stream = require('stream');
var events = require('events');

var semver = require('semver');
var color = require('color');
var BluebirdPromise = require('bluebird');

var sharp = require('./build/Release/sharp');
var libvipsVersion = sharp.libvipsVersion();

var maximum = {
  width: 0x3FFF,
  height: 0x3FFF,
  pixels: Math.pow(0x3FFF, 2)
};

var Sharp = function(input) {
  if (!(this instanceof Sharp)) {
    return new Sharp(input);
  }
  stream.Duplex.call(this);
  this.options = {
    // input options
    bufferIn: null,
    streamIn: false,
    sequentialRead: false,
    limitInputPixels: maximum.pixels,
    // ICC profiles
    iccProfilePath: path.join(__dirname, 'icc') + path.sep,
    // resize options
    topOffsetPre: -1,
    leftOffsetPre: -1,
    widthPre: -1,
    heightPre: -1,
    topOffsetPost: -1,
    leftOffsetPost: -1,
    widthPost: -1,
    heightPost: -1,
    width: -1,
    height: -1,
    canvas: 'crop',
    gravity: 0,
    angle: 0,
    rotateBeforePreExtract: false,
    flip: false,
    flop: false,
    withoutEnlargement: false,
    interpolator: 'bilinear',
    // operations
    background: [0, 0, 0, 255],
    flatten: false,
    blurSigma: 0,
    sharpenRadius: 0,
    sharpenFlat: 1,
    sharpenJagged: 2,
    gamma: 0,
    greyscale: false,
    normalize: 0,
    // output options
    output: '__input',
    progressive: false,
    quality: 80,
    compressionLevel: 6,
    withoutAdaptiveFiltering: false,
    withoutChromaSubsampling: false,
    trellisQuantisation: false,
    overshootDeringing: false,
    optimiseScans: false,
    streamOut: false,
    withMetadata: false,
    tileSize: 256,
    tileOverlap: 0,
    // Function to notify of queue length changes
    queueListener: function(queueLength) {
      module.exports.queue.emit('change', queueLength);
    }
  };
  if (typeof input === 'string') {
    // input=file
    this.options.fileIn = input;
  } else if (typeof input === 'object' && input instanceof Buffer) {
    // input=buffer
    this.options.bufferIn = input;
  } else {
    // input=stream
    this.options.streamIn = true;
  }
  return this;
};
module.exports = Sharp;
util.inherits(Sharp, stream.Duplex);

/*
  EventEmitter singleton emits queue length 'change' events
*/
module.exports.queue = new events.EventEmitter();

/*
  Supported image formats
*/
module.exports.format = sharp.format();

/*
  Handle incoming chunk on Writable Stream
*/
Sharp.prototype._write = function(chunk, encoding, callback) {
  /*jslint unused: false */
  if (this.options.streamIn) {
    if (typeof chunk === 'object' && chunk instanceof Buffer) {
      if (this.options.bufferIn instanceof Buffer) {
        // Append to existing Buffer
        this.options.bufferIn = Buffer.concat(
          [this.options.bufferIn, chunk],
          this.options.bufferIn.length + chunk.length
        );
      } else {
        // Create new Buffer
        this.options.bufferIn = new Buffer(chunk.length);
        chunk.copy(this.options.bufferIn);
      }
      callback();
    } else {
      callback(new Error('Non-Buffer data on Writable Stream'));
    }
  } else {
    callback(new Error('Unexpected data on Writable Stream'));
  }
};

// Crop this part of the resized image (Center/Centre, North, East, South, West)
module.exports.gravity = {'center': 0, 'centre': 0, 'north': 1, 'east': 2, 'south': 3, 'west': 4};

Sharp.prototype.crop = function(gravity) {
  this.options.canvas = 'crop';
  if (typeof gravity === 'number' && !Number.isNaN(gravity) && gravity >= 0 && gravity <= 4) {
    this.options.gravity = gravity;
  } else {
    throw new Error('Unsupported crop gravity ' + gravity);
  }
  return this;
};

Sharp.prototype.extract = function(topOffset, leftOffset, width, height) {
  /*jslint unused: false */
  var suffix = this.options.width === -1 && this.options.height === -1 ? 'Pre' : 'Post';
  var values = arguments;
  ['topOffset', 'leftOffset', 'width', 'height'].forEach(function(name, index) {
    if (typeof values[index] === 'number' && !Number.isNaN(values[index]) && (values[index] % 1 === 0) && values[index] >= 0) {
      this.options[name + suffix] = values[index];
    } else {
      throw new Error('Non-integer value for ' + name + ' of ' + values[index]);
    }
  }.bind(this));
  // Ensure existing rotation occurs before pre-resize extraction
  if (suffix === 'Pre' && this.options.angle !== 0) {
    this.options.rotateBeforePreExtract = true;
  }
  return this;
};

/*
  Set the background colour for embed and flatten operations.
  Delegates to the 'Color' module, which can throw an Error
  but is liberal in what it accepts, clamping values to sensible min/max.
*/
Sharp.prototype.background = function(rgba) {
  var colour = color(rgba);
  this.options.background = colour.rgbArray();
  this.options.background.push(colour.alpha() * 255);
  return this;
};

Sharp.prototype.embed = function() {
  this.options.canvas = 'embed';
  return this;
};

Sharp.prototype.max = function() {
  this.options.canvas = 'max';
  return this;
};

Sharp.prototype.min = function() {
  this.options.canvas = 'min';
  return this;
};

/*
  Ignoring the aspect ratio of the input, stretch the image to
  the exact width and/or height provided via the resize method.
*/
Sharp.prototype.ignoreAspectRatio = function() {
  this.options.canvas = 'ignore_aspect';
  return this;
};

Sharp.prototype.flatten = function(flatten) {
  this.options.flatten = (typeof flatten === 'boolean') ? flatten : true;
  return this;
};

/*
  Rotate output image by 0, 90, 180 or 270 degrees
  Auto-rotation based on the EXIF Orientation tag is represented by an angle of -1
*/
Sharp.prototype.rotate = function(angle) {
  if (typeof angle === 'undefined') {
    this.options.angle = -1;
  } else if (!Number.isNaN(angle) && [0, 90, 180, 270].indexOf(angle) !== -1) {
    this.options.angle = angle;
  } else {
    throw new Error('Unsupported angle (0, 90, 180, 270) ' + angle);
  }
  return this;
};

/*
  Flip the image vertically, about the Y axis
*/
Sharp.prototype.flip = function(flip) {
  this.options.flip = (typeof flip === 'boolean') ? flip : true;
  return this;
};

/*
  Flop the image horizontally, about the X axis
*/
Sharp.prototype.flop = function(flop) {
  this.options.flop = (typeof flop === 'boolean') ? flop : true;
  return this;
};

/*
  Do not enlarge the output if the input width *or* height are already less than the required dimensions
  This is equivalent to GraphicsMagick's ">" geometry option:
    "change the dimensions of the image only if its width or height exceeds the geometry specification"
*/
Sharp.prototype.withoutEnlargement = function(withoutEnlargement) {
  this.options.withoutEnlargement = (typeof withoutEnlargement === 'boolean') ? withoutEnlargement : true;
  return this;
};

/*
  Blur the output image.
  Call without a sigma to use a fast, mild blur.
  Call with a sigma to use a slower, more accurate Gaussian blur.
*/
Sharp.prototype.blur = function(sigma) {
  if (typeof sigma === 'undefined') {
    // No arguments: default to mild blur
    this.options.blurSigma = -1;
  } else if (typeof sigma === 'boolean') {
    // Boolean argument: apply mild blur?
    this.options.blurSigma = sigma ? -1 : 0;
  } else if (typeof sigma === 'number' && !Number.isNaN(sigma) && sigma >= 0.3 && sigma <= 1000) {
    // Numeric argument: specific sigma
    this.options.blurSigma = sigma;
  } else {
    throw new Error('Invalid blur sigma (0.3 to 1000.0) ' + sigma);
  }
  return this;
};

/*
  Sharpen the output image.
  Call without a radius to use a fast, mild sharpen.
  Call with a radius to use a slow, accurate sharpen using the L of LAB colour space.
    radius - size of mask in pixels, must be integer
    flat - level of "flat" area sharpen, default 1
    jagged - level of "jagged" area sharpen, default 2
*/
Sharp.prototype.sharpen = function(radius, flat, jagged) {
  if (typeof radius === 'undefined') {
    // No arguments: default to mild sharpen
    this.options.sharpenRadius = -1;
  } else if (typeof radius === 'boolean') {
    // Boolean argument: apply mild sharpen?
    this.options.sharpenRadius = radius ? -1 : 0;
  } else if (typeof radius === 'number' && !Number.isNaN(radius) && (radius % 1 === 0) && radius >= 1) {
    // Numeric argument: specific radius
    this.options.sharpenRadius = radius;
    // Control over flat areas
    if (typeof flat !== 'undefined' && flat !== null) {
      if (typeof flat === 'number' && !Number.isNaN(flat) && flat >= 0) {
        this.options.sharpenFlat = flat;
      } else {
        throw new Error('Invalid sharpen level for flat areas ' + flat + ' (expected >= 0)');
      }
    }
    // Control over jagged areas
    if (typeof jagged !== 'undefined' && jagged !== null) {
      if (typeof jagged === 'number' && !Number.isNaN(jagged) && jagged >= 0) {
        this.options.sharpenJagged = jagged;
      } else {
        throw new Error('Invalid sharpen level for jagged areas ' + jagged + ' (expected >= 0)');
      }
    }
  } else {
    throw new Error('Invalid sharpen radius ' + radius + ' (expected integer >= 1)');
  }
  return this;
};

/*
  Set the interpolator to use for the affine transformation
*/
module.exports.interpolator = {
  nearest: 'nearest',
  bilinear: 'bilinear',
  bicubic: 'bicubic',
  nohalo: 'nohalo',
  locallyBoundedBicubic: 'lbb',
  vertexSplitQuadraticBasisSpline: 'vsqbs'
};
Sharp.prototype.interpolateWith = function(interpolator) {
  var isValid = false;
  for (var key in module.exports.interpolator) {
    if (module.exports.interpolator[key] === interpolator) {
      isValid = true;
      break;
    }
  }
  if (isValid) {
    this.options.interpolator = interpolator;
  } else {
    throw new Error('Invalid interpolator ' + interpolator);
  }
  return this;
};

/*
  Darken image pre-resize (1/gamma) and brighten post-resize (gamma).
  Improves brightness of resized image in non-linear colour spaces.
*/
Sharp.prototype.gamma = function(gamma) {
  if (typeof gamma === 'undefined') {
    // Default gamma correction of 2.2 (sRGB)
    this.options.gamma = 2.2;
  } else if (!Number.isNaN(gamma) && gamma >= 1 && gamma <= 3) {
    this.options.gamma = gamma;
  } else {
    throw new Error('Invalid gamma correction (1.0 to 3.0) ' + gamma);
  }
  return this;
};

/*
  Enhance output image contrast by stretching its luminance to cover the full dynamic range
*/
Sharp.prototype.normalize = function(normalize) {
  if (process.platform !== 'win32') {
    this.options.normalize = (typeof normalize === 'boolean') ? normalize : true;
  } else {
    console.error('normalize unavailable on win32 platform');
  }
  return this;
};
Sharp.prototype.normalise = Sharp.prototype.normalize;

/*
  Convert to greyscale
*/
Sharp.prototype.greyscale = function(greyscale) {
  this.options.greyscale = (typeof greyscale === 'boolean') ? greyscale : true;
  return this;
};
Sharp.prototype.grayscale = Sharp.prototype.greyscale;

Sharp.prototype.progressive = function(progressive) {
  this.options.progressive = (typeof progressive === 'boolean') ? progressive : true;
  return this;
};

Sharp.prototype.sequentialRead = function(sequentialRead) {
  this.options.sequentialRead = (typeof sequentialRead === 'boolean') ? sequentialRead : true;
  return this;
};

Sharp.prototype.quality = function(quality) {
  if (!Number.isNaN(quality) && quality >= 1 && quality <= 100) {
    this.options.quality = quality;
  } else {
    throw new Error('Invalid quality (1 to 100) ' + quality);
  }
  return this;
};

/*
  zlib compression level for PNG output
*/
Sharp.prototype.compressionLevel = function(compressionLevel) {
  if (!Number.isNaN(compressionLevel) && compressionLevel >= 0 && compressionLevel <= 9) {
    this.options.compressionLevel = compressionLevel;
  } else {
    throw new Error('Invalid compressionLevel (0 to 9) ' + compressionLevel);
  }
  return this;
};

/*
  Disable the use of adaptive row filtering for PNG output - requires libvips 7.42.0+
*/
Sharp.prototype.withoutAdaptiveFiltering = function(withoutAdaptiveFiltering) {
  if (semver.gte(libvipsVersion, '7.42.0')) {
    this.options.withoutAdaptiveFiltering = (typeof withoutAdaptiveFiltering === 'boolean') ? withoutAdaptiveFiltering : true;
  } else {
    console.error('withoutAdaptiveFiltering requires libvips 7.41.0+');
  }
  return this;
};

/*
  Disable the use of chroma subsampling for JPEG output
*/
Sharp.prototype.withoutChromaSubsampling = function(withoutChromaSubsampling) {
  this.options.withoutChromaSubsampling = (typeof withoutChromaSubsampling === 'boolean') ? withoutChromaSubsampling : true;
  return this;
};

/*
  Apply trellis quantisation to JPEG output - requires libvips 8.0.0+ compiled against mozjpeg 3.0+
*/
Sharp.prototype.trellisQuantisation = function(trellisQuantisation) {
  if (semver.gte(libvipsVersion, '8.0.0')) {
    this.options.trellisQuantisation = (typeof trellisQuantisation === 'boolean') ? trellisQuantisation : true;
  } else {
    console.error('trellisQuantisation requires libvips 8.0.0+');
  }
  return this;
};
Sharp.prototype.trellisQuantization = Sharp.prototype.trellisQuantisation;

/*
  Apply overshoot deringing to JPEG output - requires libvips 8.0.0+ compiled against mozjpeg 3.0+
*/
Sharp.prototype.overshootDeringing = function(overshootDeringing) {
  if (semver.gte(libvipsVersion, '8.0.0')) {
    this.options.overshootDeringing = (typeof overshootDeringing === 'boolean') ? overshootDeringing : true;
  } else {
    console.error('overshootDeringing requires libvips 8.0.0+');
  }
  return this;
};

/*
  Optimise scans in progressive JPEG output - requires libvips 8.0.0+ compiled against mozjpeg 3.0+
*/
Sharp.prototype.optimiseScans = function(optimiseScans) {
  if (semver.gte(libvipsVersion, '8.0.0')) {
    this.options.optimiseScans = (typeof optimiseScans === 'boolean') ? optimiseScans : true;
    if (this.options.optimiseScans) {
      this.progressive();
    }
  } else {
    console.error('optimiseScans requires libvips 8.0.0+');
  }
  return this;
};
Sharp.prototype.optimizeScans = Sharp.prototype.optimiseScans;

/*
  Include all metadata (EXIF, XMP, IPTC) from the input image in the output image
*/
Sharp.prototype.withMetadata = function(withMetadata) {
  this.options.withMetadata = (typeof withMetadata === 'boolean') ? withMetadata : true;
  return this;
};

/*
  Tile size and overlap for Deep Zoom output
*/
Sharp.prototype.tile = function(size, overlap) {
  // Size of square tiles, in pixels
  if (typeof size !== 'undefined' && size !== null) {
    if (!Number.isNaN(size) && size % 1 === 0 && size >= 1 && size <= 8192) {
      this.options.tileSize = size;
    } else {
      throw new Error('Invalid tile size (1 to 8192) ' + size);
    }
  }
  // Overlap of tiles, in pixels
  if (typeof overlap !== 'undefined' && overlap !== null) {
    if (!Number.isNaN(overlap) && overlap % 1 === 0 && overlap >=0 && overlap <= 8192) {
      if (overlap > this.options.tileSize) {
        throw new Error('Tile overlap ' + overlap + ' cannot be larger than tile size ' + this.options.tileSize);
      }
      this.options.tileOverlap = overlap;
    } else {
      throw new Error('Invalid tile overlap (0 to 8192) ' + overlap);
    }
  }
  return this;
};

Sharp.prototype.resize = function(width, height) {
  if (!width) {
    this.options.width = -1;
  } else {
    if (typeof width === 'number' && !Number.isNaN(width) && width % 1 === 0 && width > 0 && width <= maximum.width) {
      this.options.width = width;
    } else {
      throw new Error('Invalid width (1 to ' + maximum.width + ') ' + width);
    }
  }
  if (!height) {
    this.options.height = -1;
  } else {
    if (typeof height === 'number' && !Number.isNaN(height) && height % 1 === 0 && height > 0 && height <= maximum.height) {
      this.options.height = height;
    } else {
      throw new Error('Invalid height (1 to ' + maximum.height + ') ' + height);
    }
  }
  return this;
};

/*
  Limit the total number of pixels for input images
  Assumes the image dimensions contained in the file header can be trusted
*/
Sharp.prototype.limitInputPixels = function(limit) {
  if (typeof limit === 'number' && !Number.isNaN(limit) && limit % 1 === 0 && limit > 0) {
    this.options.limitInputPixels = limit;
  } else {
    throw new Error('Invalid pixel limit (1 to ' + maximum.pixels + ') ' + limit);
  }
  return this;
};

/*
  Write output image data to a file
*/
Sharp.prototype.toFile = function(output, callback) {
  if (!output || output.length === 0) {
    var errOutputInvalid = new Error('Invalid output');
    if (typeof callback === 'function') {
      callback(errOutputInvalid);
    } else {
      return BluebirdPromise.reject(errOutputInvalid);
    }
  } else {
    if (this.options.fileIn === output) {
      var errOutputIsInput = new Error('Cannot use same file for input and output');
      if (typeof callback === 'function') {
        callback(errOutputIsInput);
      } else {
        return BluebirdPromise.reject(errOutputIsInput);
      }
    } else {
      this.options.output = output;
      return this._sharp(callback);
    }
  }
  return this;
};

/*
  Write output to a Buffer
*/
Sharp.prototype.toBuffer = function(callback) {
  return this._sharp(callback);
};

/*
  Force JPEG output
*/
Sharp.prototype.jpeg = function() {
  this.options.output = '__jpeg';
  return this;
};

/*
  Force PNG output
*/
Sharp.prototype.png = function() {
  this.options.output = '__png';
  return this;
};

/*
  Force WebP output
*/
Sharp.prototype.webp = function() {
  this.options.output = '__webp';
  return this;
};

/*
  Force raw, uint8 output
*/
Sharp.prototype.raw = function() {
  var supportsRawOutput = module.exports.format.raw.output;
  if (supportsRawOutput.file || supportsRawOutput.buffer || supportsRawOutput.stream) {
    this.options.output = '__raw';
  } else {
    console.error('Raw output requires libvips 7.42.0+');
  }
  return this;
};

/*
  Force output to a given format
  @param format is either the id as a String or an Object with an 'id' attribute
*/
Sharp.prototype.toFormat = function(format) {
  var id = format;
  if (typeof format === 'object') {
    id = format.id;
  }
  if (typeof id === 'string' && typeof module.exports.format[id] === 'object' && typeof this[id] === 'function') {
    this[id]();
  } else {
    throw new Error('Unsupported format ' + format);
  }
  return this;
};

/*
  Used by a Writable Stream to notify that it is ready for data
*/
Sharp.prototype._read = function() {
  if (!this.options.streamOut) {
    this.options.streamOut = true;
    this._sharp();
  }
};

/*
  Invoke the C++ image processing pipeline
  Supports callback, stream and promise variants
*/
Sharp.prototype._sharp = function(callback) {
  var that = this;
  if (typeof callback === 'function') {
    // output=file/buffer
    if (this.options.streamIn) {
      // output=file/buffer, input=stream
      this.on('finish', function() {
        sharp.resize(that.options, callback);
      });
    } else {
      // output=file/buffer, input=file/buffer
      sharp.resize(this.options, callback);
    }
    return this;
  } else if (this.options.streamOut) {
    // output=stream
    if (this.options.streamIn) {
      // output=stream, input=stream
      this.on('finish', function() {
        sharp.resize(that.options, function(err, data) {
          if (err) {
            that.emit('error', new Error(err));
          } else {
            that.push(data);
          }
          that.push(null);
        });
      });
    } else {
      // output=stream, input=file/buffer
      sharp.resize(this.options, function(err, data) {
        if (err) {
          that.emit('error', new Error(err));
        } else {
          that.push(data);
        }
        that.push(null);
      });
    }
    return this;
  } else {
    // output=promise
    if (this.options.streamIn) {
      // output=promise, input=stream
      return new BluebirdPromise(function(resolve, reject) {
        that.on('finish', function() {
          sharp.resize(that.options, function(err, data) {
            if (err) {
              reject(err);
            } else {
              resolve(data);
            }
          });
        });
      });
    } else {
      // output=promise, input=file/buffer
      return new BluebirdPromise(function(resolve, reject) {
        sharp.resize(that.options, function(err, data) {
          if (err) {
            reject(err);
          } else {
            resolve(data);
          }
        });
      });
    }
  }
};

/*
  Reads the image header and returns metadata
  Supports callback, stream and promise variants
*/
Sharp.prototype.metadata = function(callback) {
  var that = this;
  if (typeof callback === 'function') {
    if (this.options.streamIn) {
      this.on('finish', function() {
        sharp.metadata(that.options, callback);
      });
    } else {
      sharp.metadata(this.options, callback);
    }
    return this;
  } else {
    if (this.options.streamIn) {
      return new BluebirdPromise(function(resolve, reject) {
        that.on('finish', function() {
          sharp.metadata(that.options, function(err, data) {
            if (err) {
              reject(err);
            } else {
              resolve(data);
            }
          });
        });
      });
    } else {
      return new BluebirdPromise(function(resolve, reject) {
        sharp.metadata(that.options, function(err, data) {
          if (err) {
            reject(err);
          } else {
            resolve(data);
          }
        });
      });
    }
  }
};

/*
  Get and set cache memory and item limits
*/
module.exports.cache = function(memory, items) {
  if (typeof memory !== 'number' || Number.isNaN(memory)) {
    memory = null;
  }
  if (typeof items !== 'number' || Number.isNaN(items)) {
    items = null;
  }
  return sharp.cache(memory, items);
};

/*
  Get and set size of thread pool
*/
module.exports.concurrency = function(concurrency) {
  if (typeof concurrency !== 'number' || Number.isNaN(concurrency)) {
    concurrency = null;
  }
  return sharp.concurrency(concurrency);
};

/*
  Get internal counters
*/
module.exports.counters = function() {
  return sharp.counters();
};

/*
  Get the version of the libvips library
*/
module.exports.libvipsVersion = function() {
  return libvipsVersion;
};
