'use strict';

const utils = require('./utils');
const WebGLRunner = require('../backend/web-gl/runner');
const CPURunner = require('../backend/cpu/runner');
const OpenCLRunner = require('../backend/open-cl/runner');
const WebGLValidatorKernel = require('../backend/web-gl/validator-kernel');
const GPUCore = require("./gpu-core");

/**
 * Initialises the GPU.js library class which manages the webGlContext for the created functions.
 * @class
 * @extends GPUCore
 */
class GPU extends GPUCore {
	/**
	 * Creates an instance of GPU.
	 * @param {any} settings - Settings to set mode, andother properties. See #GPUCore
	 * @memberOf GPU#
	 */
	constructor(settings) {
		super(settings);

		settings = settings || {};
		this._canvas = settings.canvas || null;
		this._webGl = settings.webGl || null;
		let mode = settings.mode || 'webgl';

    if (typeof window !== 'undefined') {
      if (!utils.isWebGlSupported()) {
        console.warn('Warning: gpu not supported, falling back to cpu support');
        mode = 'cpu';
      }
    }

		this.kernels = [];

		const runnerSettings = {
			canvas: this._canvas,
			webGl: this._webGl
		};

		if (mode) {
			switch (mode.toLowerCase()) {
				case 'cpu':
					this._runner = new CPURunner(runnerSettings);
					break;
				case 'gpu':
          this._runner = typeof window === 'undefined'
            ? new OpenCLRunner(runnerSettings)
            : new WebGLRunner(runnerSettings);
          break;
        case 'opencl':
          this._runner = new OpenCLRunner(runnerSettings);
          break;
				case 'webgl':
					this._runner = new WebGLRunner(runnerSettings);
					break;
				case 'webgl-validator':
					this._runner = new WebGLRunner(runnerSettings);
					this._runner.Kernel = WebGLValidatorKernel;
					break;
				default:
					throw new Error(`"${mode}" mode is not defined`);
			}
		}
	}
	/**
	 *
	 * This creates a callable function object to call the kernel function with the argument parameter set
	 *
	 * @name createKernel
	 * @function
	 * @memberOf GPU##
	 * 
	 * @param {Function} fn - The calling to perform the conversion
	 * @param {Object} settings - The parameter configuration object
	 * @property {String} settings.dimensions - Thread dimension array (Defeaults to [1024])                                                    
	 * @property {String} settings.mode - CPU / GPU configuration mode (Defaults to null)
	 * 
	 * The following modes are supported
	 * *null* / *'auto'* : Attempts to build GPU mode, else fallbacks
	 * *'gpu'* : Attempts to build GPU mode, else fallbacks
	 * *'cpu'* : Forces JS fallback mode only
	 *
	 *
	 * @returns {Function} callable function to run
	 *
	 */
	createKernel(fn, settings) {
		//
		// basic parameters safety checks
		//
		if (typeof fn === 'undefined') {
			throw 'Missing fn parameter';
		}
		if (!utils.isFunction(fn)) {
			throw 'fn parameter not a function';
		}

		const kernel = this._runner.buildKernel(fn, settings || {});

		//if canvas didn't come from this, propagate from kernel
		if (!this._canvas) {
			this._canvas = kernel.getCanvas();
		}
		if (!this._runner.canvas) {
			this._runner.canvas = kernel.getCanvas();
		}

		this.kernels.push(kernel);

		return kernel;
	}

	/**
	 *
	 * Create a super kernel which executes sub kernels 
	 * and saves their output to be used with the next sub kernel.
	 * This can be useful if we want to save the output on one kernel,
	 * and then use it as an input to another kernel. *Machine Learning*
	 * 
	 * @name createKernelMap
	 * @function
	 * @memberOf GPU#
	 * 
	 * @param {Object|Array} subKernels - Sub kernels for this kernel
	 * @param {Function} rootKernel - Root kernel
	 * 
	 * @returns {Function} callable kernel function
	 * 
	 * @example
	 * const megaKernel = gpu.createKernelMap({
	 *   addResult: function add(a, b) {
	 *     return a[this.thread.x] + b[this.thread.x];
	 *   },
	 *   multiplyResult: function multiply(a, b) {
	 *     return a[this.thread.x] * b[this.thread.x];
	 *   },
	 *  }, function(a, b, c) {
	 *       return multiply(add(a, b), c);
	 * });
	 *		
	 * megaKernel(a, b, c);
	 * 
	 * Note: You can also define subKernels as an array of functions. 
	 * > [add, multiply]
	 *
	 */
	createKernelMap() {
		let fn;
		let settings;
		if (typeof arguments[arguments.length - 2] === 'function') {
			fn = arguments[arguments.length - 2];
			settings = arguments[arguments.length - 1];
		} else {
			fn = arguments[arguments.length - 1];
		}

		if (!utils.isWebGlDrawBuffersSupported()) {
			this._runner = new CPURunner(settings);
		}

		const kernel = this.createKernel(fn, settings);
		if (Array.isArray(arguments[0])) {
			const functions = arguments[0];
			for (let i = 0; i < functions.length; i++) {
				kernel.addSubKernel(functions[i]);
			}
		} else {
			const functions = arguments[0];
			for (let p in functions) {
				if (!functions.hasOwnProperty(p)) continue;
				kernel.addSubKernelProperty(p, functions[p]);
			}
		}

		return kernel;
	}

	/**
	 * 
	 * Combine different kernels into one super Kernel, 
	 * useful to perform multiple operations inside one 
	 * kernel without the penalty of data transfer between 
	 * cpu and gpu.
	 * 
	 * The number of kernel functions sent to this method can be variable.
	 * You can send in one, two, etc.
	 * 
	 * @name combineKernels
	 * @function
	 * @memberOf GPU#
	 * 
	 * @param {Function} subKernels - Kernel function(s) to combine.
	 * @param {Function} rootKernel - Root kernel to combine kernels into
	 * 
	 * @example 
	 * 	combineKernels(add, multiply, function(a,b,c){
	 *	 	return add(multiply(a,b), c)
	 *	})
	 * 
	 * @returns {Function} Callable kernel function
	 *
	 */
	combineKernels() {
		const lastKernel = arguments[arguments.length - 2];
		const combinedKernel = arguments[arguments.length - 1];
		if (this.getMode() === 'cpu') return combinedKernel;

		const canvas = arguments[0].getCanvas();
		let webGl = arguments[0].getWebGl();

		for (let i = 0; i < arguments.length - 1; i++) {
			arguments[i]
				.setCanvas(canvas)
				.setWebGl(webGl)
				.setOutputToTexture(true);
		}

		return function() {
			combinedKernel.apply(null, arguments);
			const texSize = lastKernel.texSize;
			const gl = lastKernel.getWebGl();
			const threadDim = lastKernel.threadDim;
			let result;
			if (lastKernel.floatOutput) {
				result = new Float32Array(texSize[0] * texSize[1] * 4);
				gl.readPixels(0, 0, texSize[0], texSize[1], gl.RGBA, gl.FLOAT, result);
			} else {
				const bytes = new Uint8Array(texSize[0] * texSize[1] * 4);
				gl.readPixels(0, 0, texSize[0], texSize[1], gl.RGBA, gl.UNSIGNED_BYTE, bytes);
				result = new Float32Array(bytes.buffer);
			}

			result = result.subarray(0, threadDim[0] * threadDim[1] * threadDim[2]);

			if (lastKernel.dimensions.length === 1) {
				return result;
			} else if (lastKernel.dimensions.length === 2) {
				return utils.splitArray(result, lastKernel.dimensions[0]);
			} else if (lastKernel.dimensions.length === 3) {
				const cube = utils.splitArray(result, lastKernel.dimensions[0] * lastKernel.dimensions[1]);
				return cube.map(function(x) {
					return utils.splitArray(x, lastKernel.dimensions[0]);
				});
			}
		};
	}


	/**
	 *
	 * Adds additional functions, that the kernel may call.
	 *
	 * @name addFunction
	 * @function
	 * @memberOf GPU#
	 *
	 * @param {Function|String} fn - JS Function to do conversion
	 * @param {String[]|Object} paramTypes - Parameter type array, assumes all parameters are 'float' if null
	 * @param {String} returnType - The return type, assumes 'float' if null
	 *
	 * @returns {GPU} returns itself
	 *
	 */
	addFunction(fn, paramTypes, returnType) {
		this._runner.functionBuilder.addFunction(null, fn, paramTypes, returnType);
		return this;
	}

	/**
	 *
	 * Return the current mode in which gpu.js is executing.
	 * @name getMode
	 * @function
	 * @memberOf GPU#
	 * 
	 * @returns {String} The current mode, "cpu", "webgl", etc.
	 *
	 */
	getMode() {
		return this._runner.getMode();
	}

	/**
	 *
	 * Return TRUE, if browser supports WebGl AND Canvas
	 *
	 * @name get isWebGlSupported
	 * @function
	 * @memberOf GPU#
	 * 
	 * Note: This function can also be called directly `GPU.isWebGlSupported()`
	 *
	 * @returns {Boolean} TRUE if browser supports webGl
	 *
	 */
	isWebGlSupported() {
		return utils.isWebGlSupported();
	}

	/**
	 *
	 * Return the canvas object bound to this gpu instance.
	 *
	 * @name getCanvas
	 * @function
	 * @memberOf GPU#
	 * 
	 * @returns {Object} Canvas object if present
	 *
	 */
	getCanvas() {
		return this._canvas;
	}

	/**
	 *
	 * Return the webGl object bound to this gpu instance.
	 *
	 * @name getWebGl
	 * @function
	 * @memberOf GPU#
	 * 
	 * @returns {Object} WebGl object if present
	 *
	 */
	getWebGl() {
		return this._webGl;
	}
};

// This ensure static methods are "inherited"
// See: https://stackoverflow.com/questions/5441508/how-to-inherit-static-methods-from-base-class-in-javascript
Object.assign(GPU, GPUCore);

module.exports = GPU;