const Events = require('events'), http = require('http'), https = require('https'), url = require('url')
const {CookieJar} = require('tough-cookie')
const net = require('net')

const httpJar = new CookieJar()
const httpsJar = new CookieJar()

const HttpAgent = new http.Agent()
const HttpsAgent = new https.Agent({rejectUnauthorized: false})

class DownloadStream extends Events {
	constructor(opts){
		super()
		this.opts = opts
        this.ips = null
        this.failedIPs = []
        this.errors = []
        this.timeout = opts.timeout && opts.timeout.response ? opts.timeout.response : 30000
		process.nextTick(() => {
            this.start().catch(err => this.emitError(err))
        })
	}
    async options(ip, family){
        const opts = {
            path: this.parsed.path,
            port: this.parsed.port || (this.parsed.protocol == 'http:' ? 80 : 443)
        }
        if(opts.path.indexOf(' ') != -1){
            opts.path = opts.path.replaceAll(' ', '%20')
        }
        opts.host = this.parsed.hostname
		opts.headers = this.opts.headers || {host: this.parsed.hostname, connection: 'close'}
        const cookie = await this.getCookies()
        if(cookie){
            opts.headers.cookie = cookie
        }
		opts.timeout = this.timeout
        opts.protocol = this.parsed.protocol
        opts.decompress = false
        if(this.parsed.protocol == 'https:'){
            opts.rejectUnauthorized = false
        }
        opts.agent = this.parsed.protocol == 'http:' ? HttpAgent : HttpsAgent
		return opts
	}
    async start(){
        let fine
        this.parsed = url.parse(this.opts.url, false)
        this.jar = this.parsed.protocol == 'http:' ? httpJar : httpsJar
        const options = await this.options()
        fine = await this.get(options)
        if(fine){
            this.end()
        } else {
            this.emitError(this.errors.map(s => String(s)).join("\n"))
        }
    }
	get(options){
        return new Promise(resolve => {
            let timer, fine, req, response, resolved
            const close = () => {
                response && response.req && response.req.destroy()
                response && response.destroy()
                req && req.destroy()
                response = req = null
            }
            const fail = error => {
                clearTimer()
                this.errors.push(error)
                if(!resolved){
                    resolved = true
                    resolve(fine)
                }
                close()
            }
            const clearTimer = () => {
                if(timer){
                    clearTimeout(timer)
                }
            }
            const startTimer = () => {
                clearTimer()
                timer = setTimeout(() => {
                    fail('Timeouted')
                    close()
                }, this.timeout)
            }
            const finish = () => {
                clearTimer()
                if(!resolved){
                    resolved = true
                    resolve(fine)
                    close()
                }
            }
            this.on('destroy', close)
            req = (options.protocol == 'http:' ? http : https).request(options, res => {
                if(this.destroyed){
                    fail('destroyed')
                    return close()
                }
                fine = true
                response = res
                if(response.headers['set-cookie']){
                    if (response.headers['set-cookie'] instanceof Array) {
                        response.headers['set-cookie'].map(c => this.setCookies(c).catch(console.error))
                    } else {
                        this.setCookies(response.headers['set-cookie']).catch(console.error)
                    }
                    delete response.headers['set-cookie']
                }
                this.emit('response', response)
                res.on('data', chunk => {
                    this.emit('data', chunk)
                    startTimer()                  
                })
                res.on('error', fail)
                res.on('end', () => finish())
                res.on('close', () => finish())
                res.on('finish', () => finish())
                res.socket.on('end', () => finish())
                res.socket.on('close', () => finish())
                res.socket.on('finish', () => finish())
                startTimer()
            }).on('error', fail)
            req.end()
            startTimer()
        })
	}
    async getCookies(){
        return new Promise((resolve, reject) => {
            (this.parsed.protocol == 'http:' ? httpJar : httpsJar).getCookies(this.opts.url, (err, cookies) => {
                if(err){
                    resolve('')
                }
                resolve(cookies.join('; '))
            })
        })
    }
    async setCookies(header){
        return new Promise((resolve, reject) => {
            (this.parsed.protocol == 'http:' ? httpJar : httpsJar).setCookie(header, this.opts.url, err => {
                if(err){
                    return reject(err)
                }
                resolve(true)
            })
        })
    }
	emitError(error){
		if(this.listenerCount('error')){
			this.emit('error', error)
		}
		this.end()
	}
    end(){
        if(!this.ended){
            this.ended = true
            this.emit('end')
        }
        this.destroy()
    }
	destroy(){
        if(!this.ended){
            this.end()
        }
        if(this.destroyed){
		    this.destroyed = true
        }
        this.emit('destroy')
	}
}

module.exports = DownloadStream
