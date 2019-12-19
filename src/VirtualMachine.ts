/**
    Copyright 2010 Steve Hanov
    Copyright 2019 Jan Starzak

    This file is part of qb.js

    qb.js is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    qb.js is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with qb.js.  If not, see <http://www.gnu.org/licenses/>.
*/

import { sprintf, getDebugConsole as dbg } from './DebugConsole'
import { Instruction } from './CodeGenerator'
import {
	DeriveTypeNameFromVariable,
	ScalarVariable,
	SomeScalarType,
	IsNumericType,
	ArrayVariable,
	Dimension,
	SomeType
} from './Types'
import { IConsole } from './Console'
import { IAudioDevice } from './AudioDevice'
import { QBasicProgram } from './QBasic'
import { Locus } from './Tokenizer'
import * as EventEmitter from 'eventemitter3'

export enum RuntimeErrorCodes {
	DIVISION_BY_ZERO = 101,
	STACK_OVERFLOW = 201,
	STACK_UNDERFLOW = 202,
	UKNOWN_SYSCALL = 301,
	IO_ERROR = 401
}

export class RuntimeError extends Error {
	private _code: RuntimeErrorCodes
	get code(): RuntimeErrorCodes {
		return this._code
	}
	private _locus: Locus | undefined
	get locus(): Locus | undefined {
		return this._locus
	}
	constructor(code: RuntimeErrorCodes, message: string, locus?: Locus) {
		super(message)
		this._code = code
		this._locus = locus
	}
}

export class TraceBuffer {
	readonly MAX_LINES = 200
	lines: string[] = []
	constructor() {}

	public toString() {
		return this.lines.join('')
	}

	public printf(...args: any[]) {
		let str = sprintf(args)
		this.lines.push(str)
		if (this.lines.length > this.MAX_LINES) {
			this.lines.shift()
		}
		dbg().printf('%s', str)
	}
}

export class StackFrame {
	// Address to return to when the subroutine has ended.
	pc: any

	// map from name to the Scalar or Array variable.
	variables: object = {}

	constructor(pc: any) {
		this.pc = pc
		this.variables = {}
	}
}

const DEBUG = false

/**
 The VirtualMachine runs the bytecode given to it. It can run in one of two
 modes: Synchronously or Asynchronously.

 In synchronous mode, the program is run to completion before returning from
 the run() function. This can cause a browser window to freeze until execution
 completes.

 In asynchronous mode, a javascript interval is used. Every so often, we run
 some instructions and then stop. That way, the program appears to run while
 letting the user use the browser window.
 */
export class VirtualMachine extends EventEmitter<'error'> {
	// Stack
	stack: any[] = []

	// program counter.
	pc = 0

	// list of StackFrames. The last one is searched for variable references.
	// Failing that, the first one ( the main procedure ) is searched for any
	// shared variables matching the name.
	callstack: StackFrame[] = []

	// The console.
	cons: IConsole

	// The audio device
	audio: IAudioDevice | undefined

	// The bytecode (array of Instruction objects)
	instructions: Instruction[] = []

	// Array of user defined times.
	types: { [key: string]: SomeType } = {}

	// set of names of shared variables.
	shared: object = {}

	// Trace buffer for debugging.
	trace: TraceBuffer = new TraceBuffer()

	// Index of next data statement to be read.
	dataPtr: number = 0

	// Array of strings or numbers from the data statements.
	data: any[] = []

	// True if we are running asynchronously.
	asynchronous: boolean = false

	// True if the virtual machine is suspended for some reason (for example,
	// waiting for user input)
	suspended: boolean = false // eg. for INPUT statement.

	// The javascript interval used for running asynchronously.
	interval: number | undefined = undefined

	// Number of milliseconds between intervals
	private readonly INTERVAL_MS = 50

	// Number of instructions to run in an interval
	instructionsPerInterval = 2048

	// The last random number generated by a RND function. We have to remember
	// it because RND 0 returns the last one generated.
	lastRandomNumber = 0

	private defaultType: SomeScalarType

	frame: StackFrame

	/**
	 * @param console A Console object that will be used as the screen.
	 */
	constructor(console: IConsole, audio?: IAudioDevice) {
		super()
		this.cons = console
		this.audio = audio

		if (!DEBUG) {
			this.trace = { printf: function() {} } as TraceBuffer
		}
	}

	/**
     Resets the virtual machine, halting any running program.
    */
	public reset(program: QBasicProgram) {
		if (program) {
			this.instructions = program.instructions
			this.types = program.types
			this.defaultType = program.defaultType
			this.data = program.data
			this.shared = program.shared
		}

		this.stack.length = 0
		this.callstack.length = 0
		this.callstack.push(new StackFrame(this.instructions.length))
		this.frame = this.callstack[0]
		this.dataPtr = 0
		this.suspended = false
		if (this.interval) {
			window.clearInterval(this.interval)
			this.interval = undefined
		}

		this.pc = 0
		if (program) {
			this.cons.reset(program.testMode)
		} else {
			this.cons.reset()
		}
	}

	/**
     Run a program to completion in synchronous mode, or
    Starts running a program in asynchronous mode.

    In asynchronous mode, it returns immediately.
    */
	public run(program: QBasicProgram, synchronous: boolean) {
		this.reset(program)
		this.asynchronous = !synchronous

		if (synchronous) {
			try {
				while (this.pc < this.instructions.length) {
					this.runOneInstruction()
				}
			} catch (e) {
				this.emit('error', e)
			}
		} else {
			this.interval = setInterval(() => this.runSome(), this.INTERVAL_MS)
		}
	}

	/**
     Suspend the CPU, maintaining all state. This happens when the program
    is waiting for user input.
    */
	public suspend() {
		this.suspended = true
		if (this.asynchronous) {
			clearInterval(this.interval)
		}
	}

	/**
     Resume the CPU, after previously being suspended.
    */
	public resume() {
		this.suspended = false
		if (this.asynchronous) {
			this.runSome()
			this.interval = setInterval(() => this.runSome(), this.INTERVAL_MS)
		}
	}

	/**
     Runs some instructions during asynchronous mode.
    */
	public runSome() {
		try {
			for (
				let i = 0;
				i < this.instructionsPerInterval && this.pc < this.instructions.length && !this.suspended;
				i++
			) {
				this.runOneInstruction()
			}
		} catch (e) {
			this.suspend()
			this.emit('error', e)
		}

		if (this.pc === this.instructions.length) {
			clearInterval(this.interval)
		}
	}

	public runOneInstruction() {
		let instr = this.instructions[this.pc++]
		try {
			if (DEBUG) {
				this.trace.printf('Execute [%s] %s\n', this.pc - 1, instr)
			}
			instr.instr.execute(this, instr.arg)
		} catch (e) {
			if (e instanceof RuntimeError) {
				throw new RuntimeError(e.code, e.message, instr.locus)
			}
		}
	}

	public setVariable(name: string, value: any) {
		if (this.shared[name]) {
			this.callstack[0].variables[name] = value
		} else {
			this.frame.variables[name] = value
		}
	}

	public getVariable(name: string) {
		let frame: StackFrame
		if (this.shared[name]) {
			frame = this.callstack[0]
		} else {
			frame = this.frame
		}

		if (frame.variables[name]) {
			return frame.variables[name]
		} else {
			// must create variable
			const typeName = DeriveTypeNameFromVariable(name)
			let type: SomeScalarType
			if (typeName === null) {
				type = this.defaultType
			} else {
				type = this.types[typeName] as SomeScalarType
			}

			let scalar = new ScalarVariable<any>(type, type.createInstance())
			frame.variables[name] = scalar
			return scalar
		}
	}

	public printStack() {
		if (DEBUG) {
			for (let i = 0; i < this.stack.length; i++) {
				let item = this.stack[i]
				let name = /*getObjectClass*/ item
				if (name === 'ScalarVariable') {
					name += ' ' + item.value
				}
				this.trace.printf('stack[%s]: %s\n', i, name)
			}
		}
	}

	public pushScalar(value, typeName) {
		this.stack.push(new ScalarVariable<any>(this.types[typeName] as SomeScalarType, value))
	}
}

interface ISystemFunction {
	type: string
	args: string[]
	minArgs: number
	action: (vm: VirtualMachine) => void
}

type SystemFunctionsDefinition = {
	[key: string]: ISystemFunction
}

/**
    Defines the functions that can be called from a basic program. Functions
    must return a value. System subs, which do not return a value, are defined
    elsewhere. Some BASIC keywords, such as SCREEN, are both a function and a
    sub, and may do different things in the two contexts.

    Each entry is indexed by function name. The record contains:

    type: The name of the type of the return value of the function.

    args: An array of names of types of each argument.

    minArgs: the number of arguments required.

    action: A function taking the virtual machine as an argument. To implement
    the function, it should pop its arguments off the stack, and push its
    return value onto the stack. If minArgs <> args.length, then the top of the
    stack is an integer variable that indicates how many arguments were passed
    to the function.
 */
export const SystemFunctions: SystemFunctionsDefinition = {
	RND: {
		type: 'SINGLE',
		args: ['INTEGER'],
		minArgs: 0,
		action: function(vm) {
			let numArgs = vm.stack.pop()
			let n = 1
			if (numArgs === 1) {
				n = vm.stack.pop()
			}
			if (n === 0) {
				vm.stack.push(vm.lastRandomNumber)
			} else {
				vm.stack.push(Math.random())
			}
		}
	},

	CHR$: {
		type: 'STRING',
		args: ['INTEGER'],
		minArgs: 1,
		action: function(vm) {
			let num = vm.stack.pop()
			vm.stack.push(String.fromCharCode(num))
		}
	},

	INKEY$: {
		type: 'STRING',
		args: [],
		minArgs: 0,
		action: function(vm) {
			let code = vm.cons.getKeyFromBuffer()
			let result = ''

			if (code !== -1) {
				result = String.fromCodePoint(code)
				if (code === 0) {
					result += String.fromCharCode(vm.cons.getKeyFromBuffer())
				}
			}

			vm.stack.push(result)
		}
	},

	LEN: {
		type: 'INTEGER',
		args: ['STRING'],
		minArgs: 1,
		action: function(vm) {
			vm.stack.push(vm.stack.pop().length)
		}
	},

	MID$: {
		type: 'STRING',
		args: ['STRING', 'INTEGER', 'INTEGER'],
		minArgs: 2,
		action: function(vm) {
			let numArgs = vm.stack.pop()
			let len
			if (numArgs === 3) {
				len = vm.stack.pop()
			}
			let start = vm.stack.pop()
			let str = vm.stack.pop()
			vm.stack.push(str.substr(start - 1, len))
		}
	},

	LEFT$: {
		type: 'STRING',
		args: ['STRING', 'INTEGER'],
		minArgs: 2,
		action: function(vm) {
			let num = vm.stack.pop()
			let str = vm.stack.pop()
			vm.stack.push(str.substr(0, num))
		}
	},

	RIGHT$: {
		type: 'STRING',
		args: ['STRING', 'INTEGER'],
		minArgs: 2,
		action: function(vm) {
			let num = vm.stack.pop()
			let str = vm.stack.pop()
			vm.stack.push(str.substr(str.length - num))
		}
	},

	TIMER: {
		type: 'INTEGER',
		args: [],
		minArgs: 0,
		action: function(vm) {
			// return number of seconds since midnight. DEVIATION: We return a
			// floating point value rather than an integer, so that nibbles
			// will work properly when its timing loop returns a value less
			// than one second.
			let date = new Date()

			let result =
				date.getMilliseconds() / 1000 + date.getSeconds() + date.getMinutes() * 60 + date.getHours() * 60 * 60

			vm.stack.push(result)
		}
	},

	PEEK: {
		type: 'INTEGER',
		args: ['INTEGER'],
		minArgs: 1,
		action: function(vm) {
			// pop one argument off the stack and replace it with 0.
			vm.stack.pop()
			vm.stack.push(0)
		}
	},

	LCASE$: {
		type: 'STRING',
		args: ['STRING'],
		minArgs: 1,
		action: function(vm) {
			let str = vm.stack.pop()
			vm.stack.push(str.toLowerCase())
		}
	},

	UCASE$: {
		type: 'STRING',
		args: ['STRING'],
		minArgs: 1,
		action: function(vm) {
			vm.stack.push(vm.stack.pop().toUpperCase())
		}
	},

	STR$: {
		type: 'STRING',
		args: ['SINGLE'],
		minArgs: 1,
		action: function(vm) {
			let num = vm.stack.pop()
			vm.stack.push('' + num)
		}
	},

	SPACE$: {
		type: 'STRING',
		args: ['INTEGER'],
		minArgs: 1,
		action: function(vm) {
			let numSpaces = vm.stack.pop()
			let str = ''
			for (let i = 0; i < numSpaces; i++) {
				str += ' '
			}
			vm.stack.push(str)
		}
	},

	VAL: {
		type: 'SINGLE',
		args: ['STRING'],
		minArgs: 1,
		action: function(vm) {
			vm.stack.push(parseFloat(vm.stack.pop()))
		}
	},

	INT: {
		type: 'INTEGER',
		args: ['SINGLE'],
		minArgs: 1,
		action: function(vm) {
			vm.stack.push(Math.floor(vm.stack.pop()))
		}
	}
}

interface ISystemSubroutine {
	args?: string[]
	minArgs?: number
	action: (vm: VirtualMachine) => void
}

type SystemSubroutinesDefinition = {
	[key: string]: ISystemSubroutine
}

/**
    Defines the system subroutines that can be called from a basic program.
    Functions must return a value. System functions, which return a value, are
    defined elsewhere.

    Each entry is indexed by the name of the subroutine. The record contains:

    args: An array of names of types of each argument.

    minArgs: (optional) the number of arguments required.

    action: A function taking the virtual machine as an argument. To implement
    the function, it should pop its arguments off the stack, and push its
    return value onto the stack. If minArgs is present, and not equal to
    args.length, then the top of the stack is an integer variable that
    indicates how many arguments were passed to the function.
 */
export const SystemSubroutines: SystemSubroutinesDefinition = {
	BEEP: {
		action: function() {
			// NOT IMPLEMENTED
		}
	},

	CLS: {
		action: function(vm) {
			// clears the console screen.
			vm.cons.cls()
		}
	},

	RANDOMIZE: {
		action: function(vm) {
			// NOT IMPLEMENTED. Seeding the random number generator
			// is not possible using the built-in Javascript functions.
			vm.stack.pop()
		}
	},

	PLAY: {
		args: ['STRING', 'INTEGER'],
		minArgs: 1,
		action: function(vm) {
			const argCount = vm.stack.pop()
			let repeat: number | undefined = undefined
			const music = vm.stack.pop().value

			if (argCount > 1) {
				repeat = vm.stack.pop().value
			}

			if (vm.audio) {
				vm.suspend()
				vm.audio
					.playMusic(music, repeat || 1)
					.then(() => {
						vm.resume()
					})
					.catch(e => console.error(e))
			}
		}
	},

	BGMPLAY: {
		args: ['STRING', 'INTEGER'],
		minArgs: 1,
		action: function(vm) {
			// BGMPLAY is the same as PLAY, it just doesn't suspend the VM
			const argCount = vm.stack.pop()
			let repeat: number | undefined = undefined
			const music = vm.stack.pop().value

			if (argCount > 1) {
				repeat = vm.stack.pop().value
			}

			if (vm.audio) {
				vm.audio.playMusic(music, repeat).catch(e => console.error(e))
			}
		}
	},

	BGMSTOP: {
		action: function(vm) {
			if (vm.audio) {
				vm.audio.stopMusic()
			}
		}
	},

	SLEEP: {
		args: ['SINGLE'],
		minArgs: 0,
		action: function(vm) {
			const argCount = vm.stack.pop()
			vm.suspend()
			if (argCount === 1) {
				// if an argument is provided, wait X seconds
				const sleep = vm.stack.pop().value
				setTimeout(() => {
					vm.resume()
				}, sleep * 1000)
			} else {
				// if no argument is provided, use a global trapped key to resume
				vm.cons.onKey(-1, () => {
					vm.cons.onKey(-1, undefined)
					vm.resume()
				})
			}
		}
	},

	SYSTEM: {
		action: function() {
			// NOT IMPLEMENTED
			// vm.stack.pop();
		}
	},

	print_using: {
		action: function(vm) {
			// pop # args
			let argCount = vm.stack.pop()

			// pop terminator
			let terminator = vm.stack.pop()

			let args: any[] = []
			for (let i = 0; i < argCount - 1; i++) {
				args.unshift(vm.stack.pop())
			}

			let formatString = args.shift().value

			let curArg = 0
			let output = ''

			// for each character in the string,
			for (let pos = 0; pos < formatString.length; pos++) {
				let ch = formatString.charAt(pos)

				// if the character is '#',
				if (ch === '#') {
					// if out of arguments, then type mismatch error.
					if (curArg === args.length || !IsNumericType(args[curArg].type)) {
						// TODO: errors.
						dbg().printf('Type mismatch error.\n')
						break
					}

					// store character position
					let backupPos = pos
					let digitCount = 0
					// for each character of the string,
					for (; pos < formatString.length; pos++) {
						ch = formatString.charAt(pos)
						// if the character is '#',
						if (ch === '#') {
							// increase digit count
							digitCount++

							// if the character is ','
						} else if (ch === ',') {
							// do nothing
						} else {
							// break out of loop
							break
						}
					}

					// convert current arg to a string. Truncate or pad to
					// appropriate number of digits.
					let argAsString = '' + args[curArg].value
					if (argAsString.length > digitCount) {
						argAsString = argAsString.substr(argAsString.length - digitCount)
					} else {
						while (argAsString.length < digitCount) {
							argAsString = ' ' + argAsString
						}
					}

					let curDigit = 0

					// go back to old character position.
					// for each character of the string,
					for (pos = backupPos; pos < formatString.length; pos++) {
						ch = formatString.charAt(pos)
						// if the character is a '#'
						if (ch === '#') {
							// output the next digit.
							output += argAsString[curDigit++]
							// if the character is a ',',
						} else if (ch === ',') {
							// output a comma.
							output += ch
						} else {
							// break out.
							break
						}
					}

					// increment current argument.
					curArg += 1
					pos -= 1
				} else {
					// character was not #. output it verbatim.
					output += ch
				}
			}

			vm.cons.print(output)
			if (terminator === ',') {
				let x = vm.cons.x
				let spaces = ''
				while (++x % 14) {
					spaces += ' '
				}
				vm.cons.print(spaces)
			} else if (terminator !== ';') {
				vm.cons.print('\n')
			}
		}
	},

	LOCATE: {
		args: ['INTEGER', 'INTEGER'],
		action: function(vm) {
			let col = vm.stack.pop().value
			let row = vm.stack.pop().value
			vm.cons.locate(row, col)
		}
	},

	COLOR: {
		args: ['ANY', 'ANY', 'ANY'],
		minArgs: 1,
		action: function(vm) {
			let argCount = vm.stack.pop()

			let bg = null
			let bo = null
			if (argCount > 2) {
				bo = vm.stack.pop().value
			}
			if (argCount > 1) {
				bg = vm.stack.pop().value
			}
			let fg = vm.stack.pop().value
			vm.cons.color(fg, bg, bo)
		}
	},

	READ: {
		// Actually, arguments must be STRING or NUMBER, but there is no way to
		// indicate that to the type checker at the moment.
		args: ['ANY', 'ANY'],
		minArgs: 1,
		action: function(vm) {
			let argCount = vm.stack.pop()
			let args: any[] = []
			let i

			for (i = 0; i < argCount; i++) {
				args.unshift(vm.stack.pop())
			}

			// TODO: out of data error.
			for (i = 0; i < argCount; i++) {
				vm.trace.printf('READ %s\n', vm.data[vm.dataPtr])
				args[i].value = vm.data[vm.dataPtr++]
				if (args[i].value === null) {
					// user specified ,, in a data statement
					args[i].value = args[i].type.createInstance()
				}
			}
		}
	},

	SCREEN: {
		action: function(vm) {
			const mode = vm.stack.pop().value
			vm.cons.screen(mode)
		}
	},

	INPUT: {
		action: function(vm) {
			// TODO: Support multiple arguments. Convert strings input by the
			// user to numbers.
			let argCount = vm.stack.pop()
			let args: any[] = []

			vm.trace.printf('Argcount=%s\n', argCount)

			for (let i = 0; i < argCount; i++) {
				args.unshift(vm.stack.pop())
			}

			vm.suspend()

			vm.cons
				.input()
				.then(result => {
					args[0].value = result
					vm.resume()
				})
				.catch(e => console.error(e))
		}
	},

	SWAP: {
		action: function(vm) {
			let lhs = vm.stack.pop()
			let rhs = vm.stack.pop()
			let temp = lhs.value
			lhs.value = rhs.value
			rhs.value = temp
			// TODO: Type checking.
		}
	},

	WIDTH: {
		action: function(vm) {
			// TODO: NOT IMPLEMENTED
			vm.stack.pop()
			vm.stack.pop()
		}
	},

	YIELD: {
		action: function(vm) {
			vm.suspend()
			if (window) {
				window.requestAnimationFrame(() => vm.resume())
			} else {
				setTimeout(() => vm.resume())
			}
		}
	},

	SPSET: {
		args: ['INTEGER', 'ANY'],
		minArgs: 2,
		action: function(vm) {
			vm.suspend()
			let argCount = vm.stack.pop()
			let frames = 1
			if (argCount > 2) {
				frames = vm.stack.pop().value
			}
			const image = vm.stack.pop().value
			const spriteNum = vm.stack.pop().value

			vm.cons
				.createSprite(spriteNum, image, frames)
				.then(() => {
					vm.resume()
				})
				.catch(e => console.error(e))
		}
	},

	SPOFS: {
		args: ['INTEGER', 'INTEGER', 'INTEGER'],
		action: function(vm) {
			const y = vm.stack.pop().value
			const x = vm.stack.pop().value
			const spriteNum = vm.stack.pop().value
			vm.cons.offsetSprite(spriteNum, x, y)
		}
	},

	SPSCALE: {
		args: ['INTEGER', 'INTEGER', 'INTEGER'],
		action: function(vm) {
			const scaleY = vm.stack.pop().value
			const scaleX = vm.stack.pop().value
			const spriteNum = vm.stack.pop().value
			vm.cons.scaleSprite(spriteNum, scaleX, scaleY)
		}
	},

	SPROT: {
		args: ['INTEGER', 'INTEGER'],
		action: function(vm) {
			const angle = vm.stack.pop().value
			const spriteNum = vm.stack.pop().value
			vm.cons.rotateSprite(spriteNum, angle)
		}
	},

	SPHOME: {
		args: ['INTEGER', 'INTEGER', 'INTEGER'],
		action: function(vm) {
			const homeY = vm.stack.pop().value
			const homeX = vm.stack.pop().value
			const spriteNum = vm.stack.pop().value
			vm.cons.homeSprite(spriteNum, homeX, homeY)
		}
	},

	SPHIDE: {
		args: ['INTEGER'],
		action: function(vm) {
			const spriteNum = vm.stack.pop().value
			vm.cons.displaySprite(spriteNum, false)
		}
	},

	SPSHOW: {
		args: ['INTEGER'],
		action: function(vm) {
			const spriteNum = vm.stack.pop().value
			vm.cons.displaySprite(spriteNum, true)
		}
	},

	SPANIM: {
		args: ['INTEGER', 'INTEGER', 'INTEGER', 'INTEGER'],
		minArgs: 3,
		action: function(vm) {
			const argCount = vm.stack.pop()
			let loop = true
			if (argCount > 3) {
				loop = vm.stack.pop().value === -1 ? true : false
			}
			const stopFrame = vm.stack.pop().value
			const startFrame = vm.stack.pop().value
			const spriteNum = vm.stack.pop().value
			vm.cons.animateSprite(spriteNum, startFrame, stopFrame, loop)
		}
	},

	SPCLR: {
		args: ['INTEGER'],
		action: function(vm) {
			const spriteNum = vm.stack.pop().value
			vm.cons.clearSprite(spriteNum)
		}
	}
}

export interface IInstruction {
	name: string
	addrLabel?: boolean
	dataLabel?: boolean
	numArgs?: 0 | 1
	execute: (vm: VirtualMachine, arg: number | string | undefined) => void
}

interface IDataLabelInstruction extends IInstruction {
	dataLabel?: true
	numArgs?: 1
	execute: (vm: VirtualMachine, arg: number) => void
}

interface IAddrLabelInstruction extends IInstruction {
	addrLabel?: true
	numArgs?: 1
	execute: (vm: VirtualMachine, arg: number) => void
}

interface INoArgInstruction extends IInstruction {
	addrLabel?: false
	dataLabel?: false
	numArgs: 0
	execute: (vm: VirtualMachine, arg?: undefined) => void
}

type InstructionDefinition = {
	[key: string]: IDataLabelInstruction | IAddrLabelInstruction | INoArgInstruction
}

/**
 Defines the instruction set of the virtual machine. Each entry is indexed by
 the name of the instruction, and consists of a record of the following values:

 name: The name of the instruction for display purposes.

 addrLabel: If present, and set to "true", the argument of the instruction is
 interpretted as an address during the linking stage.

 dataLabel: If present, and set to "true", the argument of the instruction is
 the index of a DATA statement.

 numArgs: If present and set to 0, the instruction takes no arguments.
 Otherwise, it is assumed to take 1 argument.

 execute: A function taking as its first argument the virtual machine, and as
 its second argument the parameter of the instruction. It should manipulate the
 virtual machine's stack or program counter to implement the instruction.
 */
export const Instructions: InstructionDefinition = {
	FORLOOP: {
		name: 'forloop',
		addrLabel: true,
		execute: function(vm, arg) {
			// For loops are tedious to implement in bytecode, because
			// depending on whether STEP is positive or negative we either
			// compare the counter with < or >. To simplify things, we create
			// the forloop instruction to perform this comparison.

			// argument is the address of the end of the for loop.

			// stack is:
			// end value
			// step expression
			// loop variable REFERENCE

			// if the for loop is ended, then all three of its arguments are
			// popped off the stack, and we jump to the end address. Otherwise,
			// only the loop variable is popped and no branch is performed.

			let counter = vm.stack[vm.stack.length - 1]
			let step = vm.stack[vm.stack.length - 2]
			let end = vm.stack[vm.stack.length - 3]

			if ((step < 0 && counter < end) || (step > 0 && counter > end)) {
				vm.stack.length -= 3
				vm.pc = arg
			} else {
				vm.stack.pop()
			}
		}
	},

	COPYTOP: {
		name: 'copytop',
		numArgs: 0,
		execute: function(vm) {
			// Duplicates the top of the stack
			vm.stack.push(vm.stack[vm.stack.length - 1])
		}
	},

	RESTORE: {
		name: 'restore',
		dataLabel: true,
		execute: function(vm, arg) {
			// Restore the data pointer to the given value.
			if (vm.debug) {
				vm.trace.printf('RESTORE to %s\n', arg)
			}
			vm.dataPtr = arg
		}
	},

	POPVAL: {
		name: 'popval',
		execute: function(vm, arg) {
			// Argument is the name of the variable. Sets that variable's value
			// to the top of the stack.
			vm.getVariable(arg).value = vm.stack.pop()
		}
	},

	POP: {
		name: 'pop',
		numArgs: 0,
		execute: function(vm) {
			vm.stack.pop()
		}
	},

	PUSHREF: {
		name: 'pushref',
		execute: function(vm, arg) {
			// The argument is the name of a variable. Push a reference to that
			// variable onto the top of the stack.
			vm.stack.push(vm.getVariable(arg))
		}
	},

	PUSHVALUE: {
		name: 'pushvalue',
		execute: function(vm, arg) {
			// The argument is the name of a variable. Push the value of that
			// variable to the top of the stack.
			vm.stack.push(vm.getVariable(arg).value)
		}
	},

	PUSHTYPE: {
		name: 'pushtype',
		execute: function(vm, arg) {
			// The argument is the name of a built-in or user defined type.
			// Push the type object onto the stack, for later use in an alloc
			// system call.
			vm.stack.push(vm.types[arg])
		}
	},

	POPVAR: {
		name: 'popvar',
		execute: function(vm, arg) {
			// Sets the given variable to refer to the top of the stack, and
			// pops the top of the stack. The stack top must be a reference.
			vm.setVariable(arg, vm.stack.pop())
		}
	},

	NEW: {
		name: 'new',
		execute: function(vm, arg) {
			// The argument is a typename. Replace the top of the stack with a
			// reference to that value, with the given type.
			let type = vm.types[arg]
			vm.stack.push(new ScalarVariable(type, type.copy(vm.stack.pop())))
		}
	},

	END: {
		name: 'end',
		numArgs: 0,
		execute: function(vm) {
			// End the program. The CPU ends the program when the program
			// counter reaches the end of the instructions, so make that happen
			// now.
			vm.pc = vm.instructions.length
		}
	},

	UNARY_OP: {
		name: 'unary_op',
		execute: function(vm, arg) {
			let rhs = vm.stack.pop()
			let value
			if (arg === 'NOT') {
				value = ~rhs
			} else {
				vm.trace.printf('No such unary operator: %s\n', arg)
			}

			vm.stack.push(value)
		}
	},

	'=': {
		name: '=',
		numArgs: 0,
		execute: function(vm) {
			vm.stack.push(vm.stack.pop() === vm.stack.pop() ? -1 : 0)
		}
	},

	'<': {
		name: '<',
		numArgs: 0,
		execute: function(vm) {
			let rhs = vm.stack.pop()
			let lhs = vm.stack.pop()
			vm.stack.push(lhs < rhs ? -1 : 0)
		}
	},

	'<=': {
		name: '<=',
		numArgs: 0,
		execute: function(vm) {
			let rhs = vm.stack.pop()
			let lhs = vm.stack.pop()
			vm.stack.push(lhs <= rhs ? -1 : 0)
		}
	},

	'>': {
		name: '>',
		numArgs: 0,
		execute: function(vm) {
			let rhs = vm.stack.pop()
			let lhs = vm.stack.pop()
			vm.stack.push(lhs > rhs ? -1 : 0)
		}
	},

	'>=': {
		name: '>=',
		numArgs: 0,
		execute: function(vm) {
			let rhs = vm.stack.pop()
			let lhs = vm.stack.pop()
			vm.stack.push(lhs >= rhs ? -1 : 0)
		}
	},

	'<>': {
		name: '<>',
		numArgs: 0,
		execute: function(vm) {
			vm.stack.push(vm.stack.pop() !== vm.stack.pop() ? -1 : 0)
		}
	},

	AND: {
		name: 'and',
		numArgs: 0,
		execute: function(vm) {
			vm.stack.push(vm.stack.pop() & vm.stack.pop())
		}
	},

	OR: {
		name: 'or',
		numArgs: 0,
		execute: function(vm) {
			vm.stack.push(vm.stack.pop() | vm.stack.pop())
		}
	},

	'+': {
		name: '+',
		numArgs: 0,
		execute: function(vm) {
			let rhs = vm.stack.pop()
			let lhs = vm.stack.pop()
			vm.stack.push(lhs + rhs)
		}
	},

	'-': {
		name: '-',
		numArgs: 0,
		execute: function(vm) {
			let rhs = vm.stack.pop()
			let lhs = vm.stack.pop()
			vm.stack.push(lhs - rhs)
		}
	},

	'*': {
		name: '*',
		numArgs: 0,
		execute: function(vm) {
			vm.stack.push(vm.stack.pop() * vm.stack.pop())
		}
	},

	'/': {
		name: '/',
		numArgs: 0,
		execute: function(vm) {
			// TODO: \ operator.
			let rhs = vm.stack.pop()
			if (rhs === 0) throw new RuntimeError(RuntimeErrorCodes.DIVISION_BY_ZERO, 'Division by zero')
			let lhs = vm.stack.pop()
			vm.stack.push(lhs / rhs)
		}
	},

	MOD: {
		name: 'mod',
		numArgs: 0,
		execute: function(vm) {
			let rhs = vm.stack.pop()
			if (rhs === 0) throw new RuntimeError(RuntimeErrorCodes.DIVISION_BY_ZERO, 'Division by zero')
			let lhs = vm.stack.pop()
			vm.stack.push(lhs % rhs)
		}
	},

	BZ: {
		name: 'bz',
		addrLabel: true,
		execute: function(vm, arg) {
			// Branch on zero. Pop the top of the stack. If zero, jump to
			// the given address.
			let expr = vm.stack.pop()
			if (!expr) {
				vm.pc = arg
			}
		}
	},

	BNZ: {
		name: 'bnz',
		addrLabel: true,
		execute: function(vm, arg) {
			// Branch on non-zero. Pop the top of the stack. If non-zero, jump
			// to the given address.
			let expr = vm.stack.pop()
			if (expr) {
				vm.pc = arg
			}
		}
	},

	JMP: {
		name: 'jmp',
		addrLabel: true,
		execute: function(vm, arg) {
			// Jump to the given address.
			vm.pc = arg
		}
	},

	CALL: {
		name: 'call',
		addrLabel: true,
		execute: function(vm, arg) {
			// Call a function or subroutine. This creates a new stackframe
			// with no variables defined.
			vm.frame = new StackFrame(vm.pc)
			vm.callstack.push(vm.frame)
			vm.pc = arg
		}
	},

	GOSUB: {
		name: 'gosub',
		addrLabel: true,
		execute: function(vm, arg) {
			// like call, but stack frame shares all variables from the old
			// stack frame.
			let oldvariables = vm.frame.variables
			vm.frame = new StackFrame(vm.pc)
			vm.frame.variables = oldvariables
			vm.callstack.push(vm.frame)
			vm.pc = arg
		}
	},

	RET: {
		name: 'ret',
		numArgs: 0,
		execute: function(vm) {
			// Return from a gosub, function, or subroutine call.
			const returnAddr = vm.callstack.pop()
			if (returnAddr === undefined) throw new RuntimeError(RuntimeErrorCodes.STACK_UNDERFLOW, 'Stack underflow')
			vm.pc = returnAddr.pc
			vm.frame = vm.callstack[vm.callstack.length - 1]
		}
	},

	PUSHCONST: {
		name: 'pushconst',
		execute: function(vm, arg) {
			// Push a constant value onto the stack. The argument is a
			// javascript string or number.

			vm.stack.push(arg)
		}
	},

	ARRAY_DEREF: {
		name: 'array_deref',
		numArgs: 1,
		execute: function(vm, arg) {
			// Dereference an array. The top of the stack is the variable
			// reference, followed by an integer for each dimension.

			// Argument is whether we want the reference or value.

			// get the variable
			let variable = vm.stack.pop()

			let indexes: number[] = []

			// for each dimension,
			for (let i = 0; i < variable.dimensions.length; i++) {
				// pop it off the stack in reverse order.
				const index = vm.stack.pop()
				if (index === undefined) throw new RuntimeError(RuntimeErrorCodes.STACK_UNDERFLOW, 'Stack underflow')
				indexes.unshift(index)
			}

			// TODO: bounds checking.
			if (arg) {
				vm.stack.push(variable.access(indexes))
			} else {
				vm.stack.push(variable.access(indexes).value)
			}
		}
	},

	MEMBER_DEREF: {
		name: 'member_deref',
		execute: function(vm, arg) {
			// Dereference a user defined type member.
			// Argument is the javascript string containing the name of the
			// member. The top of the stack is a reference to the user
			// variable.

			let userVariable = vm.stack.pop()
			let deref = userVariable[arg]

			vm.stack.push(deref)
		}
	},

	MEMBER_VALUE: {
		name: 'member_value',
		execute: function(vm, arg) {
			// Dereference a user defined type member.
			// Argument is the javascript string containing the name of the
			// member. The top of the stack is a reference to the user
			// variable.

			let userVariable = vm.stack.pop()
			let deref = userVariable[arg]

			vm.stack.push(deref.value)
		}
	},

	ASSIGN: {
		name: 'assign',
		numArgs: 0,
		execute: function(vm) {
			// Copy the value into the variable reference.
			// Stack: left hand side: variable reference
			// right hand side: value to assign.

			let lhs = vm.stack.pop()
			let rhs = vm.stack.pop()

			lhs.value = lhs.type.copy(rhs)
		}
	},

	SYSCALL: {
		name: 'syscall',
		execute: function(vm, arg) {
			let variable
			let type
			let x
			let spaces
			let i
			// Execute a system function or subroutine. The argument is a
			// javascript string containing the name of the routine.
			if (vm.debug) {
				vm.trace.printf('Execute syscall %s\n', arg)
			}
			if (arg === 'print') {
				let num = 1
				for (i = 0; i < num; i++) {
					let what = vm.stack.pop()
					if (vm.debug) {
						vm.trace.printf('printing %s\n', what)
					}
					vm.cons.print('' + what)
				}
			} else if (arg === 'alloc_array') {
				type = vm.stack.pop()
				let numDimensions = vm.stack.pop()
				let dimensions: Dimension[] = []
				for (i = 0; i < numDimensions; i++) {
					let upper = vm.stack.pop()
					let lower = vm.stack.pop()
					dimensions.unshift(new Dimension(lower, upper))
				}

				variable = new ArrayVariable(type, dimensions)
				vm.stack.push(variable)
			} else if (arg === 'print_comma') {
				x = vm.cons.x
				spaces = ''
				while (++x % 14) {
					spaces += ' '
				}
				vm.cons.print(spaces)
			} else if (arg === 'print_tab') {
				let col = vm.stack.pop() - 1
				x = vm.cons.x
				spaces = ''
				while (++x < col) {
					spaces += ' '
				}
				vm.cons.print(spaces)
			} else if (arg === 'alloc_scalar') {
				type = vm.stack.pop()
				variable = new ScalarVariable(type, type.createInstance())
				vm.stack.push(variable)
			} else if (SystemFunctions[arg]) {
				SystemFunctions[arg].action(vm)
			} else if (SystemSubroutines[arg]) {
				SystemSubroutines[arg].action(vm)
			} else {
				throw new RuntimeError(RuntimeErrorCodes.UKNOWN_SYSCALL, 'Unknown syscall: ' + arg)
			}
		}
	}
}
