
const Download = require('../download')

class Client {
    constructor(base, storage){
        this.storage = storage
        this.debug = false
        this.base = base
        this.cachingDomain = 'cache-'+ base
        this.expires = {}
    }
    url(key){
        return this.base + '/' + key + '.json'
    }
    get(key, softTimeout){
        return new Promise((resolve, reject) => {
            if(this.debug){
                console.log('client: get', key, traceback())
            }
            const group = key.split('/').shift()
            const store = this.storage
            store.get(this.cachingDomain + key, data => {
                if(data){
                    if(this.debug){
                        console.log('client: get cached', key)
                    }
                    return resolve(data)
                } else {
                    if(this.debug){
                        console.log('client: no stored data', key)
                    }
                    store.get(this.cachingDomain + key + '-fallback', data => {
                        if(this.debug){
                            console.log('client: get', key)
                        }
                        let solved, error = err => {   
                            if(this.debug){
                                console.log('client: solve', err, solved) 
                            }
                            if(!solved){
                                solved = true
                                if(data){
                                    //console.warn(err, key)
                                    resolve(data) // fallback
                                } else {
                                    console.error('client: error', key, err)
                                    reject('connection error')
                                }
                            }
                        }
                        let url = this.url(key)
                        if(this.debug){
                            console.log('client: get', key, url)
                        }
                        Download.promise({
                            url,
                            responseType: 'json',
                            headers: {
                                'user-agent': 'Songtrip'
                            }
                        }).then(body => {
                            if(!body){
                                error('Server returned empty')
                            } else {
                                if(this.debug){
                                    console.log('client: got', key, body, this.expires[group])
                                }
                                if(typeof(this.expires[group]) != 'undefined'){
                                    store.set(this.cachingDomain + key, body, this.expires[group])
                                    store.set(this.cachingDomain + key + '-fallback', body, true)
                                } else {
                                    console.error('"'+ key +'" is not cacheable (no expires set)')
                                }
                                if(!solved){
                                    solved = true
                                    resolve(body)
                                }
                            }
                        }).catch(err => {
                            console.log('client: error: '+ String(err))
                            error(err)
                        })
                        if(typeof(softTimeout) != 'number'){
                            softTimeout = 10000
                        }
                        setTimeout(() => {
                            if(data || softTimeout == 0){
                                error('client: soft timeout ('+ key +', '+ softTimeout+'), keeping request to update data in background', data)
                            }
                        }, softTimeout)
                    })
                }
            })
        })
    }
}

module.exports = Client
