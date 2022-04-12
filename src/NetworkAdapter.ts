/**
	Copyright 2021 Jan Starzak

	This file is part of qbasic-vm

	qbasic-vm is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.

	qbasic-vm is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
	GNU General Public License for more details.

	You should have received a copy of the GNU General Public License
	along with qbasic-vm.  If not, see <http://www.gnu.org/licenses/>.
*/

import * as fetchPonyfill from 'fetch-ponyfill'
import { IFetchResponse, INetworkAdapter } from './INetworkAdapter'
const { fetch, Headers } = fetchPonyfill()
import 'websocket-polyfill'

interface SocketHandle {
	socket: WebSocket
	buffer: string[]
	eventListeners: (() => void)[]
}

const MAX_BUFFER_SIZE = 32 * 1024 * 1024

export class NetworkAdapter implements INetworkAdapter {
	private sockets: (SocketHandle | undefined)[] = []
	private fetchAborts: Set<AbortController> = new Set()
	private bufferSize = 0

	fetch(
		url: string,
		options: {
			method?: string | undefined
			headers?: Record<string, string> | undefined
			body?: string | Blob | Uint8Array | undefined
		}
	): Promise<IFetchResponse> {
		const { method, headers, body } = options

		const fetchHeaders = new Headers()
		if (headers) {
			Object.keys(headers).forEach(header => {
				fetchHeaders.set(header, headers[header])
			})
		}

		const abortController = new AbortController()
		this.fetchAborts.add(abortController)

		return fetch(url, {
			method,
			headers: fetchHeaders,
			body,
			signal: abortController.signal
		})
			.then(response => {
				this.fetchAborts.delete(abortController)
				return Promise.all([response.status, response.text()])
			})
			.then(statusAndResponse => ({
				code: statusAndResponse[0],
				body: statusAndResponse[1]
			}))
	}
	wsOpen(handle: number, url: string, protocol?: string): Promise<void> {
		return new Promise((resolve, reject) => {
			if (this.sockets[handle]) {
				throw new Error('WebSocket handle busy')
			}
			const socket = new WebSocket(url, protocol)
			const socketHandle: SocketHandle = {
				socket,
				buffer: [],
				eventListeners: []
			}
			this.sockets[handle] = socketHandle
			let opened = false
			socket.addEventListener('message', e => this.wsOnMessage(handle, e.data))
			socket.addEventListener('open', () => {
				opened = true
				resolve()
			})
			socket.addEventListener('close', () => {
				this.sockets[handle] = undefined
			})
			socket.addEventListener('error', () => {
				this.sockets[handle] = undefined
				if (!opened) {
					reject()
				}
			})
		})
	}
	wsSend(handle: number, data: string): Promise<void> {
		return new Promise(resolve => {
			const socketHandle = this.sockets[handle]
			if (!socketHandle) {
				throw new Error('Floating WebSocket handle')
			}
			socketHandle.socket.send(data)
			resolve()
		})
	}
	wsGetMessageFromBuffer(handle: number): Promise<string | undefined> {
		return new Promise(resolve => {
			const socketHandle = this.sockets[handle]
			if (!socketHandle) {
				throw new Error('Floating WebSocket handle')
			}
			const message = socketHandle.buffer.shift()
			this.bufferSize -= message ? message.length : 0
			resolve(message)
		})
	}
	wsClose(handle: number) {
		const socketHandle = this.sockets[handle]
		if (!socketHandle) {
			throw new Error('Floating WebSocket handle')
		}
		socketHandle.socket.close(1000)
		this.sockets[handle] = undefined
	}
	private wsOnMessage(handle: number, message: string) {
		const socketHandle = this.sockets[handle]
		if (!socketHandle) {
			throw new Error('Floating WebSocket handle')
		}
		if (this.bufferSize + message.length > MAX_BUFFER_SIZE) {
			return
		}
		socketHandle.buffer.push(message)
		this.bufferSize += message.length
		socketHandle.eventListeners.forEach(handler => {
			try {
				handler()
			} catch (e) {
				// prevent a broken handler from borking all event listeners
				console.error(e)
			}
		})
	}
	addEventListener(handle: number, listener: () => void): void {
		const socketHandle = this.sockets[handle]
		if (!socketHandle) {
			throw new Error('Floating WebSocket handle')
		}
		socketHandle.eventListeners.push(listener)
	}
	removeEventListener(handle: number, listener: () => void): void {
		const socketHandle = this.sockets[handle]
		if (!socketHandle) {
			throw new Error('Floating WebSocket handle')
		}
		const index = socketHandle.eventListeners.indexOf(listener)
		if (index >= 0) {
			socketHandle.eventListeners.splice(index, 1)
		}
	}
	reset() {
		this.sockets.forEach(socketHandle => {
			if (socketHandle) {
				socketHandle.socket.close(1000, 'Network adapter reset.')
			}
		})
		this.sockets.length = 0
		this.bufferSize = 0

		this.fetchAborts.forEach(abortController => abortController.abort())
		this.fetchAborts.clear()
	}
}
