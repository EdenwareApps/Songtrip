'use strict';

const Database = require('../database')
const { AcousticBrainz } = require('acousticbrainz')
const async = require('async'), fs = require('fs'), path = require('path'), https = require('https')
const Countries = require('../countries')
const Config = require('../config')
const langs = require('langs')
const ID3 = require('node-id3')
const Storage = require('../storage')
const Events = require('events')
//const Client = require('../client')
const Cloud = require('../cloud')
const Download = require('../download')
const decodeEntities = require('decode-entities')
const Playlist = require('../playlist')
//const path = require('path')

// too inaccurate: moods_mirex, mood_electronic, ismir04_rhythm, genre_dortmund
const SIMILARITY_GENRES_ALGORITHMS = ['genre_rosamerica', 'genre_tzanetakis']
const SIMILARITY_RHYTHMS_ALGORITHMS = ['genre_electronic', 'ismir04_rhythm', 'mood_party']
const NORMALIZE_REGEXES = {
    'non-alpha': new RegExp('^[^0-9A-Za-zÀ-ÖØ-öø-ÿ!\n]+|[^0-9A-Za-zÀ-ÖØ-öø-ÿ!\n]+$', 'g'), // match non alphanumeric on start or end,
    'between-brackets': new RegExp('[\(\\[].*[\)\\]]'), // match data between brackets
    'accents': new RegExp('[\\u0300-\\u036f]', 'g'), // match accents
    'spaces': new RegExp(' +', 'g')
}

var paths, storage, config, countries

function normalize(txt){
    if(!txt){
        return ''
    }
    ['"', '/', '\\', '=', "'", '-', ':'].forEach(c => {
        if(txt.indexOf(c) != -1){
            txt = txt.replaceAll(c, ' ')
        }
    })
    txt = txt.
        replace(NORMALIZE_REGEXES['between-brackets'], ' ').
        normalize('NFD').toLowerCase().replace(NORMALIZE_REGEXES['accents'], '').
        replace(NORMALIZE_REGEXES['non-alpha'], '').
        replace(NORMALIZE_REGEXES['spaces'], ' ')
    return txt
}

function getYear(date){
    let maxYear = (new Date()).getFullYear() + 1, years = Array.isArray(date) ? date : [date]
    years = years.map(y => String(y).substr(0, 4)).map(parseInt)
    years = years.filter(y => y >= 1859 && y <= maxYear)
    return years.length ? Math.min(...years) : null
}

function filterTags(tags){
    //['acoustid_id','album','artist','artists','barcode','discsubtitle','genre','label','musicbrainz_recordingid','musicbrainz_trackid','originalyear','releasecountry','title','year'].forEach(k => {
    const ret = {}
    if(tags['artist'] && !tags['artists']){
        tags['artists'] = [tags['artist']]
    }
    ret.artist = tags['artists'] && tags['artists'].length ? tags['artists'][0] : '';
    ['title'].forEach(k => { // string values
        if(tags[k]){
            if(Array.isArray(tags[k])){
                tags[k] = tags[k].filter(s => s)
                if(tags[k].length){
                    ret[k] = tags[k][0]
                }
            } else if(typeof(tags[k]) == 'string'){
                ret[k] = tags[k]
            }
        }
    });
    ['artists','musicbrainz_recordingid','genre'].forEach(k => { // array values
        if(tags[k]){
            if(Array.isArray(tags[k])){
                ret[k] = tags[k]
            } else if(typeof(tags[k]) == 'string') {
                ret[k] = [tags[k]]
            }
        }
    })
    ret.language = []
    if(tags.language){
        let languages = Array.isArray(tags.language) ? tags.language : [tags.language]
        languages = languages.map(l => l.split("\0")).flat().map(l => l.split(',')).flat().map(l => l.trim())
        languages = languages.filter(c => typeof(c) == 'string')
        if(languages.length){
            ret.language = ret.language.concat(languages)
        }
    }
    if(tags.releasecountry){
        let cs = Array.isArray(tags.releasecountry) ? tags.releasecountry : [tags.releasecountry]
        cs = cs.filter(c => typeof(c) == 'string' && c.length == 2).forEach(c => {
            let loc = countries.select(c.toLowerCase(), 'locale', 'code', true) // country to lang
            console.warn('LOC1', c, loc)
            if(loc){
                loc = loc.substr(0, 2)
                let r = langs.where('1', loc)
                console.warn('LOC2', c, loc, r)
                if(r){
                    console.warn('LOC3', c, loc, r[3])
                    ret.language.push(r[3])
                }
            }
        })
    }
    ret.language = ret.language.map(l => l.substr(0, 3).toLowerCase()).filter(l => langs.has(3, l))
    ret.language = [...new Set(ret.language)];
    ['originalyear', 'year', 'date', 'originaldate'].forEach(n => {
        if(tags[n]){
            let y = getYear(tags[n])
            if(y && (!ret.year || y < ret.year)){
                ret.year = y
            }
        }
    })
    return ret
}

class Encoder {
    constructor(secret){
        this.secret = secret
    }
    encode(text){
        const textToChars = text => text.split('').map((c) => c.charCodeAt(0))
        const byteHex = n => ('0'+ Number(n).toString(16)).substr(-2)
        const applySaltToChar = code => textToChars(this.secret).reduce((a, b) => a ^ b, code)
        return text
          .split('')
          .map(textToChars)
          .map(applySaltToChar)
          .map(byteHex)
          .join('')
    } 
    decode(encoded){
        const textToChars = text => text.split('').map((c) => c.charCodeAt(0));
        const applySaltToChar = code => textToChars(this.secret).reduce((a, b) => a ^ b, code);
        return encoded
          .match(/.{1,2}/g)
          .map(hex => parseInt(hex, 16))
          .map(applySaltToChar)
          .map(charCode => String.fromCharCode(charCode))
          .join('')
    }
}


class SongtripServerClient extends Events {
    constructor(storage){
        super()
        this.storage = storage
        this.cachingDomain = 'ssc-'
        this.activeCalls = {}
        this.disconnectTimer = 0
        this.expires = {
            similar: 7 * (24 * 3600),
            lookup: 7 * (24 * 3600),
            mbid: 7 * (24 * 3600)
        }
        this.enc = new Encoder('3Qe8OPBZOym#bX6!UxSyYHJ3')
        this.socket = require('socket.io-client')('http://app.songtrip.in', {
            log: false,
            autoConnect: false
        })
        this.onLine = true
        this.waitingServerConnection = false
        this.serverConnState = 0
    }

    setInternetConnState(state){
        this.onLine = state
    }
    sleep(ms){
        return new Promise((resolve, reject) => {
            setTimeout(resolve, ms)
        })
    }
    async waitInternetConnection(){
        while(!this.onLine){
            await this.sleep(200)
        }
        return true
    }
    async waitServerConnection(){
        if(!this.waitingServerConnection){
            this.emit('offline')
            this.waitingServerConnection = true
            let connected
            while(!connected){
                connected = await this.connect().catch(() => {})
                if(!connected) await this.sleep(500)
            }
            this.waitingServerConnection = false
            this.emit('online')
        }
        return true
    }
    connect(){
        return new Promise((resolve, reject) => {
            if(this.disconnectTimer){
                clearTimeout(this.disconnectTimer)
                this.disconnectTimer = 0
            }
            if(!this.onLine){
                if(this.isScanning){
                    return this.waitInternetConnection().then(() => {
                        this.connect().then(resolve).catch(reject)
                    }).catch(reject)
                } else {
                    this.disconnect(true)
                    return reject('No internet connection')
                }
            }
            if(this.serverConnState == 2){
                resolve(true)
            } else if(this.serverConnState == 1) {
                const listeners = {
                    'connected' : resolve,
                    'connect-failed' : reject
                }
                const disconnectListeners = () => {
                    Object.keys(listeners).forEach(k => {
                        this.removeListener(k, listeners[k])
                    })
                }
                Object.keys(listeners).forEach(k => {
                    this.once(k, () => {
                        disconnectListeners()
                        listeners[k]()
                    })
                })
            } else {
                this.serverConnState = 1
                let resolved, authTimer
                const timer = setTimeout(() => {
                    if(!resolved){
                        offlineListener('Timeout')
                    }
                }, 30000)
                const offlineListener = err => {
                    if(resolved) return
                    resolved = true
                    console.error('CONNECT TIMEOUT', err)
                    this.serverConnState = 0
                    this.socket.off('connect_error', offlineListener)
                    this.socket.off('auth', authListener)
                    this.socket.off('auth-ret', authRetListener)
                    reject('server offline')
                    this.emit('connect-failed', true)
                    clearTimeout(timer)
                    clearTimeout(authTimer)
                }
                const authListener = auth => {
                    this.servedRequests = 0
                    this.socket.emit('auth', this.enc.decode(auth))
                    console.log('socket connected')
                }
                const authRetListener = auth => {
                    if(resolved) return
                    resolved = true
                    console.log('socket auth', auth)
                    this.socket.off('connect_error', offlineListener)
                    if(auth){
                        this.serverConnState = 2
                        this.emit('connected', true)
                        resolve(true)
                    } else {
                        this.serverConnState = 0
                        this.emit('connect-failed', 'auth failed')
                        reject('auth failed')
                    }
                    clearTimeout(timer)
                    clearTimeout(authTimer)
                }
                this.socket.once('connect_error', offlineListener)
                this.socket.once('auth', authListener)
                this.socket.once('auth-ret', authRetListener)
                this.socket.connect()
                authTimer = setInterval(() => { // pump to avoid missed events timeout
                    if(this.socket.connected && !resolved){
                        console.log('pump to avoid missed events timeout')
                        this.socket.emit('request-auth')
                    }
                }, 5000)
            }
        })
    }
    disconnect(force){
        if(this.disconnectTimer){
            clearTimeout(this.disconnectTimer)
            this.disconnectTimer = 0
        }
        if(!this.socket.connected || Object.keys(this.activeCalls).length){
            return
        }
        if(force === true || !this.isScanning){
            this.serverConnState = 0
            console.warn('Disconnected from server after '+ this.servedRequests +' requests', force, this.isScanning)
            this.socket.disconnect()
        } else if(this.socket.connected){
            this.disconnectTimer = setTimeout(() => {
                this.disconnect(true)
            }, 5000)
        }
    }
    key(type, atts){
        let key = type
        Object.keys(atts).forEach(k => {
            key += '-'+ k
            if(Array.isArray(atts[k])){
                key += '-'+ atts[k].join('')
            } else {
                key += '-'+ atts[k]
            }
        })
        return key
    }
    get(type, atts){
        return new Promise((resolve, reject) => {
            const key = this.cachingDomain + this.key(type, atts)
            this.storage.get(key, ret => {
                if(ret) return resolve(ret)
                const uid = type +'-'+ parseInt(Math.random() * 100000000000000)
                this.connect().then(() => {
                    let resolved
                    const connectionErrorListener = (...args) => {
                        cleanEvents()
                        if(!resolved){
                            console.error('SOCKET CONNECT_ERROR ON GET', type, args)
                            reject(args)
                        }
                    }
                    const cleanEvents = () => {
                        if(this.activeCalls[uid]){
                            delete this.activeCalls[uid]
                        }
                        this.socket.removeListener('error', connectionErrorListener)
                        this.socket.removeListener('connect_error', connectionErrorListener)
                    }
                    this.activeCalls[uid] = true
                    atts.uid = uid
                    this.socket.once('ret-'+ uid, ret => {
                        resolved = true
                        cleanEvents()
                        this.servedRequests++
                        this.disconnect()
                        resolve(ret)
                        this.storage.set(key, ret, ret ? 30 * (24 * 3600) : 3600)
                    })
                    this.socket.emit(type, atts)
                    this.socket.on('error', connectionErrorListener)
                    this.socket.on('connect_error', connectionErrorListener)
                    setTimeout(() => {
                        connectionErrorListener('Timeout')
                    }, 30000)
                    // TODO: on any connection error, this.promise will never resolve, maybe some timeout and connection error detection
                }).catch(reject)
            })
        })
    }
    async similarArtists(artists){
        let similars = await this.get('similar', {artists}).catch(console.error)
        return similars ? similars : {}
    }
    async mbid(tags){
        const knownKeys = ['title', 'album', 'year']
        const atts = {}
        Object.keys(tags).forEach(k => {
            if(knownKeys.includes(k)){
                const tk = k == 'title' ? 'recording' : k
                if(Array.isArray(tags[k])){
                    if(tags[k].length){
                        atts[tk] = tags[k][0]
                    } else {
                        atts[tk] = ''
                    }
                } else {
                    atts[tk] = tags[k]
                }
                if(tk == 'year'){
                    atts[tk] = parseInt(atts[tk])
                    if(atts[tk] < 1860 && atts[tk] > 2100){
                        delete atts[tk]
                    }
                }
            }            
        })
        if(tags.artists && tags.artists.length){
            atts.artist = (tags.artists.length > 1 && tags.artists[0].indexOf(tags.artists[1]) != -1) ? tags.artists[1] : tags.artists[0]
            console.log('ARTIST', atts.artist, tags.artists[0], tags.artists[1])
        }
        if(!atts.artist || !atts.recording) return ''
        let mbid = await this.get('mbid', atts).catch(console.error)
        if(Array.isArray(mbid)){
            return mbid
        } else {
            return false
        }
    }
}

class ScannerAcousticBrainzQueue {
    constructor(){
        this.abrainz = new AcousticBrainz()
        this.idsQueue = {}
        this.batchSize = 20
        this.queue = async.queue((ids, done) => {
            ids = ids.split(',')
            console.log('CALLING ABRAINZ', ids.length)
            this.fetch(ids).then(ret => {
                console.log('CALLED ABRAINZ', ret, ids)
                ids.forEach(id => {
                    if(typeof(this.idsQueue[id]) == 'undefined') return
                    let cbs = this.idsQueue[id].callbacks
                    delete this.idsQueue[id]
                    if(ret[id]){
                        cbs.forEach(cb => {
                            cb(null, this.parse(ret[id], id))
                        })
                    } else {
                        cbs.forEach(cb => {
                            cb('data not found: '+ id)
                        })
                    }
                })
            }).catch(err => {
                console.error(err)
                ids.forEach(id => {
                    if(typeof(this.idsQueue[id]) == 'undefined') return
                    let cbs = this.idsQueue[id].callbacks
                    delete this.idsQueue[id]
                    cbs.forEach(cb => {
                        cb(err)
                    })
                })
            }).finally(() => {
                done(null, true)
            })
        }, 1)
    }
    async fetch(ids){
        const high = await this.abrainz.getHighLevel(ids).catch(console.error)
        if(!high){
            throw new Error('unable to fetch data')
        }
        const results = {}
        Object.keys(high).forEach(id => {
            results[id] = high[id][0]
        })
        return results
    }
    parse(info, id){
        console.warn('PARSE', info)
        let parsed = {};
        parsed['musicbrainz_recordingid'] = id
        SIMILARITY_GENRES_ALGORITHMS.concat(SIMILARITY_RHYTHMS_ALGORITHMS).forEach(type => { // deep genres
            delete info.highlevel[type]['version'] // save storage space
            parsed[type] = info.highlevel[type]
        });
        ['happy', 'sad', 'relaxed', 'aggressive'].forEach(n => {
            let m = 'mood_'+ n
            delete info.highlevel[m]['version'] // save storage space
            parsed[m] = info.highlevel[m]
        })
        if(info.metadata.tags){
            Object.assign(parsed, filterTags(info.metadata.tags))
        }
        return parsed
    }
    pushID(id, callback, force){
        let key = 'abrainz-'+ id
        console.log('abrainz pushid', id, force)
        storage.get(key, info => {
            if(info){
                console.log('abrainz from cache', info)
                callback(null, info)
            } else {
                if(typeof(this.idsQueue[id]) == 'undefined'){
                    console.log('abrainz NOT cached', id)
                    this.idsQueue[id] = {id, state: 0, callbacks: [
                        (err, info) => {
                            let expiral = err ? 3600 : 365 * (24 * 3600)
                            storage.set(key, info || {}, expiral)
                        }
                    ]}
                }
                this.idsQueue[id].callbacks.push(callback)
                this.pump(force)
            }
        })
    }
    push(tags, callback, force){
        if(tags['musicbrainz_recordingid'] && tags['musicbrainz_recordingid'].length){
            let i = 0, ids = tags['musicbrainz_recordingid'].filter(s => s)
            console.log('abrainz push', ids)
            let process = err => {
                i++
                if(ids.length){
                    let id = ids.shift()
                    if(!force && typeof(this.shouldPump) == 'function'){
                        force = this.shouldPump()
                    }
                    this.pushID(id, (err, info) => {
                        if(err || !info || !Object.keys(info).length){
                            console.log('mbid #'+ i +' failed', id)
                            process(err || 'no mbid info')
                        } else {
                            console.log('mbid #'+ i +' worked', id)
                            callback(null, info)
                        }
                    }, force)
                } else {
                    console.log('all mbids had failed', tags['musicbrainz_recordingid'])
                    callback(err || 'all mbids had failed')
                }
            }
            process()
        } else {
            return callback('no musicbrainz_recordingid tag')
        }
    }
    pump(){
        let elegibles = []
        let reached = Object.keys(this.idsQueue).some(id => {
            if(this.idsQueue[id].state == 0){
                elegibles.push(id)
                if(elegibles.length >= this.batchSize){
                    return true
                }
            }
        })
        let force = this.shouldPump()
        if(force || reached){
            if(elegibles.length){
                elegibles.forEach(id => this.idsQueue[id].state = 1)
                let hasMore = Object.keys(this.idsQueue).some(id => this.idsQueue[id].state == 0)
                this.queue.push(elegibles.join(','), () => {}, force && !hasMore)
                console.log('PUMP', force, hasMore)
                if(hasMore) this.pump()
            }
        }
    }
}

class ScannerParseArtists extends Events {
    constructor(opts){
        super()
        this.opts = Object.assign({}, opts)
        if(opts && opts.paths){
            paths = opts.paths
            storage = new Storage(paths, {main: true})
            countries = new Countries()
            config = new Config(paths.data +'/config.json')
        } else {
            throw 'No paths given at Scanner'
        }
        this.config = config
    }
    parseArtists(row){
        let artists = []
        if(row['artist']) artists.push(row.artist)
        if(row['artists']) artists = artists.concat(row.artists)
        artists = [...new Set(artists.map(a => normalize(a)))]
        artists = artists.map(a => this.parseArtistName(a)).flat()
        return [...new Set(artists.filter(a => a))]
    }
    parseArtistName(artist){
        let found, ars = [artist]
        // removed & (e|and|y) due to the duet possibility like "K-Ci & Jojo" vs "Jojo"
        const stopwords = [' featuring ', ' f/ ', ',', ';', ' part. ', ' feat. ', ' feat ', ' ft.', ' ft ', ' part ', '|']
        stopwords.forEach(w => {
            if(artist.indexOf(w) != -1){
                if(!found) found = true
                if(w != ',') artist = artist.replaceAll(w, ',')
            }
        })
        if(found){
            return [...new Set(artist.split(',').map(s => s.trim()).filter(s => s))]
        }
        return [artist]
    }
    countArtistsSongs(artists){
        let count = 0
        Object.values(this.db.data).forEach(r => {
            if(r.artists && r.artists.some(a => artists.includes(a))){
                count++
            }
        })
        return count
    }
}

class ScannerVideoServer extends ScannerParseArtists {
    constructor(opts){
        super(opts)
        this.vport = 0
        this.cache = {}
        setTimeout(() => this.startVideoServer(), 2000) // a delay to avoid slowing down the app loading
    }
    handleRequest(req, res){
        const defHeaders = {
            'access-control-allow-origin': '*',
            'access-control-allow-methods': 'GET',
            'access-control-allow-headers': 'Origin, X-Requested-With, Content-Type, Cache-Control, Accept, Authorization'
        }          
        this.vsPrepare()
        const qs = this.urlm.parse(req.url, true).query
        console.warn('HANDLE URL', req.url)
        if(req.url.substr(0, 2) == '/?') {
            if(qs.artist || qs.title){
                this.vsRun(qs).then(videoUrl => {
                    res.writeHead(307, Object.assign({
                        'location': videoUrl,
                        'content-length': 0
                    }, defHeaders))
                    res.end()
                    this.vsAcquiesce(req.url)
                }).catch(err => {
                    console.error(err)
                    res.writeHead(204, Object.assign({
                        'content-length': 0
                    }, defHeaders))
                    res.end()
                })
            } else {
                res.writeHead(204, {
                    'content-length': 0
                })
                res.end()
            }
        } else {
            const url = this.unproxify(req.url)
            console.warn('UNPROXIFY', url)
            const stream = new Download({
                url,
                debug: true
            })
            stream.on('response', (status, headers) => {
                headers = Object.assign(headers, defHeaders)
                res.writeHead(status, headers)
            })
            stream.on('data', chunk => res.write(chunk))
            stream.on('end', () => res.end())
            stream.start()            
        }
    }
    proxify(url){
        if(typeof(url) == 'string' && url.indexOf('//') != -1){
			if(url.substr(0, 7) == 'http://') {
				url = 'http://127.0.0.1:'+ this.vport +'/'+ url.substr(7)
			} else if(url.substr(0, 8) == 'https://') {
				url = 'http://127.0.0.1:'+ this.vport +'/s/'+ url.substr(8)
			}
        }
        return url
    }
    unproxify(url){
        if(typeof(url) == 'string'){
            if(url.substr(0, 3) == '/s/'){
                url = 'https://' + url.substr(3)
            } else if(url.charAt(0) == '/' && url.charAt(1) != '/'){
                url = 'http://' + url.substr(1)
            } else if(url.indexOf('//') != -1){
                if(url.indexOf(this.vaddr +':'+ this.opts.port +'/') != -1){
					url = url.replace(new RegExp('^(http://|//)'+ this.vaddr.replaceAll('.', '\\.') +':'+ this.vport +'/', 'g'), '$1')
					url = url.replace('://s/', 's://')
                } 
            }                      
            if(url.indexOf('&') != -1 && url.indexOf(';') != -1){
                url = decodeEntities(url)
            }
        }
        return url
	}
    startVideoServer(){
        this.vaddr = '127.0.0.1'
        this.vport = 17539
        const http = require('http')
        this.vserver = http.createServer(this.handleRequest.bind(this))
        this.vserver.listen(this.vport)
    }
    vsPrepare(){
        if(!this.urlm){
            this.urlm = require('url')
            this.ytsr = require('ytsr')
            this.ytdl = require('ytdl-core')
        }
    }
    vsMemCacheGet(key){
        if(typeof(this.cache[key]) != 'undefined' && this.cache[key].ttl >= this.time()){
            return this.cache[key].value
        }
        return undefined
    }
    vsMemCacheSet(key, value, ttl){
        this.cache[key] = {
            value,
            ttl: ttl + this.time()
        }
    }
    async vsRun(qs){
        let url = await this.vsGetVideoPageURL(qs)
        let videoUrl = await this.vsGetDirectVideoURL(url)
        console.warn({url, videoUrl})
        return this.proxify(videoUrl)
    }
    async vsGetVideoPageURL(qs){
        let url, terms = [qs.artist, qs.title].filter(s => s).join(' ')
        if(this.vsMemCacheGet('url-'+ terms)){
            return this.vsMemCacheGet('url-'+ terms)
        }
        const filters = await this.ytsr.getFilters(terms)
        const filter = filters.get('Type').get('Video')
        const options = {
            pages: 1, 
            requestOptions: {
                rejectUnauthorized: false,
                transform: (parsed) => {
                    return Object.assign(parsed, {
                        rejectUnauthorized: false
                    })
                }
            }
        }
        const results = await this.ytsr(filter.url, options)
        results.items.filter(t => !t.isLive).some(t => {
            // do any validation here, we may compare song time to video time, check for vevo, give an score for each url and pick the better one, compare thumbnails to see if are different between them
            // let icon = t.thumbnails.sortByProp('width').shift().url
            url = t.url
            return true
        })
        if(!url) throw 'url not found'  
        this.vsMemCacheSet('url-'+ terms, url, 3600)
        return url
    }
    async vsGetVideoInfo(url){
        if(this.vsMemCacheGet('info-'+ url)){
            return this.vsMemCacheGet('info-'+ url)
        }
        let info, err, retries = 5
        while((!info || !info.formats) && retries){
            if(retries < 5){
                console.warn('RETRY', this.time())
            }
            retries--
            info = await this.ytdl.getInfo(url, {     
                requestOptions: {
                    rejectUnauthorized: false,
                    transform: (parsed) => {
                        return Object.assign(parsed, {
                            rejectUnauthorized: false
                        })
                    }
                }
            }).catch(e => {
                console.error(e)
                if(String(e).match(new RegExp('Status code: 4'))){ // permanent error, like 410
                    retries = 0
                }
            })
        }
        if(!info) throw err
        this.vsMemCacheSet('info-'+ url, info, 120)
        return info
    }
    async vsGetDirectVideoURL(url){
        let info = await this.vsGetVideoInfo(url)
        if(!info) throw 'no info found for '+ url
        console.warn('INFO', info)
        let ret = this.vsSelectTrack(info.formats, 1024 * 1024) // TODO SET BANDWIDTH HERE
        return ret.url
    }
    vsSelectTrack(tracks, bandwidth){
        let chosen, chosenBandwidth
        tracks.filter(s => s.hasVideo && s.hasAudio).filter(s => s.container == 'mp4').filter(s => {
            return !!s.codecs.match(new RegExp('(avc1|mp4a)'))
        }).sortByProp('bitrate').some((track, i) => {
            if(!chosen){
                chosen = track.url
                chosenBandwidth = track.bitrate
            } else {
                if(!bandwidth || track.bitrate <= bandwidth){
                    chosen = track.url
                    chosenBandwidth = track.bitrate
                    if(!bandwidth && i == 1){ // if we don't know the connection speed yet, use the #1 to skip a possible audio track
                        return true
                    }
                } else {
                    return true // to break
                }
            }
        })
        return {url: chosen, bandwidth: chosenBandwidth}
    }
    vsUrl(artist, title){
        let url = 'http://127.0.0.1:'+ this.vport +'/?artist='+ encodeURIComponent(artist) +'&title='+ encodeURIComponent(title)
        return url
    }
    vsUrlFromFile(file){
        let data = this.db.get(file)
        if(data){
            let url = 'http://127.0.0.1:'+ this.vport +'/?artist='+ encodeURIComponent(data.artist) +'&title='+ encodeURIComponent(data.title)
            return url
        }
    }
    async vsAcquiesce(url){
        if(!this.vsActiveUrls || !this.vsActiveUrls.length){
            return
        }
        this.vsPrepare()
        if(url){
            let pos = this.vsActiveUrls.indexOf(url)
            if(pos != -1 && pos < (this.vsActiveUrls.length - 2)){
                const qs = this.urlm.parse(this.vsActiveUrls[pos], true).query
                let result = await this.vsGetVideoPageURL(qs)
                console.log('ACQUIESCED FROM '+ url +' TO '+ this.vsActiveUrls[pos], result)
            }

        } else {
            const qs = this.urlm.parse(this.vsActiveUrls[0], true).query
            await this.vsRun(qs)
        }
    }
    async vsPlaylist(files){
        let urls = [], sources = files.map(file => {
            try {
                let f = file, n = file.split('/').pop()
                let data = this.db.get(f)
                if(!data) return
                let src = this.vsUrl(data.artist, data.title)
                urls.push(src)
                return {
                    name: [data.artist, data.title].join(' '),
                    sources: [{
                      src,
                      type: 'video/mp4'
                    }]
                }
            } catch (e) {
                console.error(e)
            }
        }).filter(s => s)
        this.vsActiveUrls = urls
        this.vsAcquiesce()
        return sources
    }
}

class ScannerParseGenres extends ScannerVideoServer {
    constructor(opts){
        super(opts)
        this.keyGenres = {
            'gospel': ['gospel', 'christian'],
            'metal': ['metal', 'power symphonique', 'goth'],
            'reggae': ['reggae'],
            'samba': ['samba', 'pagode'],
            'axe': ['axe'],
            'forro': ['forro'],
            'sertanejo': ['sertanejo'],
            'country': ['country'],
            'hip hop': ['hip hop', 'rap', 'urban crossover', 'gangsta'], 
            'classical': ['classical'],
            'dance': ['dance', 'techno', 'house'],
            'r&b': ['r&b', 'r & b', 'rnb'],
            'soul': ['soul'],
            'easy listening': ['easy listening', 'downtempo', 'ballad'],
            'blues': ['blues'],
            'mpb': ['mpb', 'musica popular brasileira', 'brazilian traditional', 'brega'],
            'latin': ['latin', 'latinos'],
            'hard rock': ['nu metal', 'industrial', 'hard rock', 'hardnheavy'],
            'rock': ['rock', 'new wave', 'punk'],
            'pop': ['pop']
        }
        this.extGenresTranslateTable = {
            'dan': 'dance',
            'hip': 'hip hop',
            'jaz': 'jazz',
            'pop': 'pop',
            'rhy': 'r&b',
            'roc': 'rock',
            'spe': 'hip hop',
            'blu': 'blues',
            'cou': 'country',
            'met': 'metal',
            'reg': 'reggae'
        }            
    }
    getKeyGenre(genres){
        let kgenres = Object.keys(genres), scores = []
        Object.keys(this.keyGenres).forEach(k => {
            scores.push({genre: k, score: kgenres.map(g => {
                return this.keyGenres[k].map(n => {
                    if(g.indexOf(n) != -1){
                        return genres[g]
                    }
                    return 0
                }).sum()
            }).sum()})
        })
        if(scores.length){
            let top = scores.filter(s => s.score).sort((a, b) => b.score - a.score).shift()
            return top ? top.genre : false
        }
    }
    mergeValues(a, b){
        return a.concat(b.filter(v => !a.includes(v)))
    }
    parseGenres(row){
        let genres = []
        if(row['genre']){
            if(typeof(row.genre) == 'string'){
                genres = [row.genre]
            } else {
                genres = row.genre.slice(0)
            }
        }
        genres = [...new Set(genres.map(a => normalize(a)))]
        genres = genres.map(a => this.parseGenreName(a)).flat()
        return [...new Set(genres.filter(a => a))]
    }
    parseGenreName(genre){
        let ars
        const stopwords = [',', ';', '/', '\\', '|']
        if(stopwords.some(w => {
            if(genre.indexOf(w) != -1){
                ars = genre.split(w).map(a => a.trim()).filter(s => s)
                return true
            }
        })) {
            ars = [...new Set(ars)]
            return ars
        }
        return genre
    }
    prepareRelatedGenres(_related, keepGenres, count=10){
        let related = {}
        console.warn('preprepare', JSON.stringify(_related))
        _related = Object.values(_related).sort((a, b) => b.count - a.count)
        let maxScore = Math.max(..._related.map(r => r.count))
        if(keepGenres){
            _related.forEach(r => {
                if(keepGenres.includes(r.genre)){
                    related[r.genre] = r.count
                }
            })
        }
        while(Object.values(related).length < count && _related.length){
            let r = _related.shift()
            if(r.count >= (maxScore /4)){
                related[r.genre] = r.count
            }
        }
        console.warn('posprepare', JSON.stringify(related), count, keepGenres)
        return {
            score: related,
            genres: Object.keys(related),
            total: Object.values(related).sum()
        }
    }
    getAllArtists(){
        let artists = []
        Object.values(this.db.data).forEach(r => {
            if(r.artists){
                r.artists.forEach(a => {
                    if(!artists.includes(a)) artists.push(a)
                })
            }
        })
        return artists.sort()
    }
    getAllArtistsWithGenres(){
        let result = {}
        this.getAllArtists().forEach(a => {
            result[a] = this.getArtistGenres(a)
        })
        return result
    }
    getArtistGenres(artist){
        let epoch = {}, related = {}
        Object.values(this.db.data).filter(r => r.artists && r.artists.includes(artist)).map(r => {
            if(r.year){
                if(!epoch.start || r.year < epoch.start){
                    epoch.start = r.year
                }
                if(!epoch.end || r.year > epoch.end){
                    epoch.end = r.year
                }
            }
            if(r.genre){
                r.genre.forEach(_g => {
                    if(typeof(related[_g]) == 'undefined'){
                        related[_g] = {g: _g, count: 0}
                    }
                    related[_g].count++
                })
            }
            if(r.genre_rosamerica){
                this.getGenresFromExtData(r).forEach(_g => {
                    if(typeof(related[_g]) == 'undefined'){
                        related[_g] = {g: _g, count: 0}
                    }
                    related[_g].count++
                })
            }
        })
        let pc = Object.values(related).map(r => r.count).sum() / 100
        let result = {genres: {}, epoch}
        Object.values(related).sort((a, b) => b.count - a.count).forEach(r => {
            result.genres[r.g] = r.count / pc
        })
        return result
    }
    getArtistsFromGenresCompareEpoch(year, epoch){
        let score
        if(year){
            if(epoch && epoch.start){
                const tolerance = 10 // years
                if(year > epoch.end){
                    score = Math.max((epoch.end + tolerance) - year, 0)
                } else if(year < epoch.start) {
                    score = Math.max(year - (epoch.start - tolerance), 0)
                } else {
                    score = tolerance
                }
            } else {
                score = 0
            }
        } else {
            score = 10
        }
        return Math.max(1, score)
    }
    getArtistsFromGenres(year, genres, scalingFactor){
        let data = this.getAllArtistsWithGenres()
        let scores = [], maxScore = 0
        let keyGenre = this.getKeyGenre(genres)
        Object.keys(data).forEach(artist => {
            let artistGenresNames = Object.keys(data[artist].genres)
            let multiplier = (!keyGenre || this.getKeyGenre(data[artist].genres) == keyGenre) ? 1 : 0.1
            let mgenres = [], score = artistGenresNames.map(g => {
                if(typeof(genres[g]) != 'undefined'){
                    mgenres.push(g)
                    return genres[g] * multiplier
                }
                return 0
            }).sum()
            if(score > 0) {
                score *= (this.getArtistsFromGenresCompareEpoch(year, data[artist].epoch) / 10)
                if(score > maxScore){
                    maxScore = score
                }
                scores.push({artist, score, mgenres})
            }
        })
        const ms = maxScore / 100
        return scores.map(s => {
            s.score = (s.score / ms) * scalingFactor
            return s 
        }).sort((a, b) => b.score - a.score)
    }
    getAnyRelatedGenres(artists, genres, count){
        let related = {}
        Object.values(this.db.data).forEach(r => {
            let songGenres = r.genre || []
            songGenres = songGenres.concat(this.getGenresFromExtData(r))
            if(songGenres){
                let similarArtist = r.artists && r.artists.filter(a => (a && artists.includes(a))).length
                if(similarArtist || genres.some(g => songGenres.includes(g))){
                    let multiplier = (similarArtist || genres.every(e => songGenres.includes(e))) ? 10 : 1
                    songGenres.forEach(_g => {
                        if(typeof(related[_g]) == 'undefined'){
                            related[_g] = {genre: _g, count: 0}
                        }
                        related[_g].count += multiplier
                    })
                }
            }
        })
        return this.prepareRelatedGenres(related, genres, count)
    }
    getAllGenreTags(){
        const ret = {}, all = Object.values(this.db.data).map(r => r.genre).flat().filter(s => s && s != 'unknown')
        all.forEach(g => {
            if(typeof(ret[g]) == 'undefined'){
                ret[g] = {g, count: 0}
            }
            ret[g].count++
        })
        return Object.values(ret).sort((a, b) => b.count - a.count)
    }
    getGenresFromExtData(a){
        let genres = []
        SIMILARITY_GENRES_ALGORITHMS.forEach(type => {
            if(a[type]){
                if(this.extGenresTranslateTable[a[type].value]){
                    genres.push(this.extGenresTranslateTable[a[type].value])
                }
            }
        })
        return genres
    }
}

class ScannerMoodSort extends ScannerParseGenres {
    constructor(opts){
        super(opts)
    }
    distance(x1, y1, x2, y2){
        return Math.hypot(x2 - x1, y2 - y1)
    }
    getByMood(x, y){
        let maxDistance = 0
        return Object.keys(this.db.data).map(file => {
            let row = this.db.get(file)
            if(row.karma){
                // reason, score, file
                let distance = this.distance(row.karma[1], row.karma[0], y, x)
                if(distance > maxDistance){
                    maxDistance = distance
                }
                return {file, distance, row}
            }
        }).filter(s => s).map(s => {
            let score = maxDistance - s.distance
            s.scores = [{score, reason: this.opts.lang.MOOD +' '+ parseInt(score)}]
            s.score = score
            return s
        })
    }
    sortByMood(scores, direction){
        let dest
        if(direction.length == 1){
            return scores.sort((a, b) => {
                if(a.row.karma && b.row.karma){
                    switch (direction) {
                        case 'n':  
                            return a.row.karma[1] - b.row.karma[1]
                            break        
                        case 's':
                            return b.row.karma[1] - a.row.karma[1]
                            break
                        case 'w':
                            return b.row.karma[0] - a.row.karma[0]
                            break
                        case 'e':
                            return a.row.karma[0] - b.row.karma[0]
                            break
                    }
                } else {                
                    return (b.row.karma && !a.row.karma) ? 1 : ((a.row.karma && !b.row.karma) ? -1 : 0)
                }
            })
        } else {
            switch (direction) {
                case 'eq': // equilibrate
                    dest = [50, 50]
                    break    
                case 'ne':
                    dest = [0, 100]
                    break        
                case 'se':
                    dest = [100, 100]
                    break
                case 'nw':
                    dest = [0, 0]
                    break        
                case 'sw':
                    dest = [100, 0]
            }
            return scores.sort((a, b) => {
                if(a.row.karma && b.row.karma){
                    let e = this.distance(100 - a.row.karma[1], a.row.karma[0], dest[0], dest[1])
                    let f = this.distance(100 - b.row.karma[1], b.row.karma[0], dest[0], dest[1])
                    return f - e
                } else {                
                    return (b.row.karma && !a.row.karma) ? 1 : ((a.row.karma && !b.row.karma) ? -1 : 0)
                }
            })
        }
    }
}

class ScannerKarma extends ScannerMoodSort {
    constructor(opts){
        super(opts)
    }
    calcKarma(row, a, b){
        let aMoodName = 'mood_'+ a, bMoodName = 'mood_'+ b, na = 'not_'+ a, nb = 'not_'+ b
        let av = (row[aMoodName].all[a] / ((row[aMoodName].all[a] + row[aMoodName].all[na]) / 50))
        let bv = (row[bMoodName].all[b] / ((row[bMoodName].all[b] + row[bMoodName].all[nb]) / 50))
        if(row[bMoodName].value == b && row[aMoodName].value == na){ // surely sad
            return 50 - bv
        } else if(row[bMoodName].value == nb && row[aMoodName].value == a){ // surely happy
            return 50 + av
        } else {
            // unsure, bittersweet? we'll use mood_party to decide so
            let party = row['mood_party'].value
            if(party == 'party'){
                return 50 + av
            } else {
                return 50 - bv
            }
        }
    }
    karma(row){
        return [
            this.calcKarma(row, 'happy', 'sad'), // happiness
            this.calcKarma(row, 'aggressive', 'relaxed') // aggressivity
        ]
    }
}

/*
Object.keys(this.db.data).forEach(file => {
    let info = await this.mm.parseFile('Z:/Meus Videos/Músicas/Pink Floyd - Hey You.flac', {
        duration: false,
        skipCovers: true,
        includeChapters: false
    })
    if(info.common){
        if(info.common.artist){
            if(Array.isArray(info.common.artist)) console.log('artist Array', info.common.artist)
            if(info.common.artists){
                if(!Array.isArray(info.common.artists)) {
                    console.log('artist not Array', info.common.artists)
                } else if(!info.common.artists.includes(info.common.artist)) {
                    console.log('artist not in artists', info.common.artists, info.common.artist)
                }
            }
        } else if(info.common.artists) {
            console.log('artists not artist', info.common.artists, info.common.artist)
        }
    }
})
*/

class ScannerBase extends ScannerKarma {
    constructor(opts){
        super(opts)
        this.playlistFormats = {
            'm3u-latin1': { // WMP
                relative: true,
                backslashes: false,
                utf8: false,
                extinf: false,
                fmt: 'm3u'
            },
            'm3u-utf8': {
                relative: true,
                backslashes: true,
                utf8: true,
                extinf: true,
                fmt: 'm3u'
            }
        }
        this.supportedExts = ['aac', 'flac', 'mp3', 'ogg', 'webm', 'wav', 'wma']
        this.playlist = new Playlist({paths})
        this.db = new Database(paths.data +'/database.db')
        this.mm = require('music-metadata')
        this.queue = {}
        this.queue.abrainz = new ScannerAcousticBrainzQueue()
        this.queue.abrainz.shouldPump = () => {
            return (!this.queue.metadata.length() && !this.queue.mbrainz.length())
        }
        this.queue.mbrainz = async.queue((tags, done) => {
            let startTime = this.time()
            console.log('CALLING MBRAINZ', tags, traceback())
            this.server.mbid(tags).then(mbids => {
                this.queuesTimes.mbrainz.push(this.time() - startTime)    
                if(mbids && mbids.length){
                    if(!Array.isArray(tags['musicbrainz_recordingid'])){
                        tags['musicbrainz_recordingid'] = []
                    }
                    mbids = mbids.sort((a, b) => b.score - a.score).map(a => a.id)
                    tags['musicbrainz_recordingid'] = tags['musicbrainz_recordingid'].concat(mbids)
                    tags['musicbrainz_recordingid'] = [...new Set(tags['musicbrainz_recordingid'])]
                    console.log('received mbids', mbids)
                }
            }).catch(console.error).finally(() => {
                done(null, tags)
                this.queue.abrainz.pump()
            })
        }, 1)        
        this.queue.metadata = async.queue((file, done) => {
            let startTime = this.time()
            this.mm.parseFile(file, {
                duration: false,
                skipCovers: true,
                includeChapters: false
            }).then(tags => {
                this.queuesTimes.metadata.push(this.time() - startTime)
                if(tags){
                    console.error(null, tags)
                    tags = this.parseMMTags(tags)
                    console.error(null, tags)
                }
                tags = this.parseFileName(file, tags)
                if(!tags.title) {
                    console.error(null, 'File has no tags: '+ file)
                    return done('File has no tags: '+ file)
                }
                done(null, tags)
            }).catch(err => {
                console.error(err)
                done(err)
            }).finally(() => {                
                this.queue.abrainz.pump()
            })
        }, 2)
        this.queuesTimes = {}
        Object.keys(this.queue).forEach(k => {
            this.queuesTimes[k] = []
            this.queue[k]._push = this.queue[k].push
            this.queue[k].push = (info, cb) => {                
                return new Promise((resolve, reject) => {
                    this.queue[k]._push(info, (err, info) => {
                        if(typeof(cb) == 'function') cb(err, info)
                        if(err) return reject(err)
                        resolve(info)
                    })
                })
            }
        })
    }
    parseFileName(file, tags){
        if(!tags) {
            tags = {}
        }
        let name = path.basename(file)
        if(file.indexOf(' - ') != -1) {
            name = name.replace(new RegExp('\.[A-Za-z0-9]{2,4}$', 'u'), '')
            name = name.split(' - ')
            if(!tags.artist) tags.artist = name[0]
            if(!tags.artists) tags.artists = [name[0]]
            if(!tags.title) tags.title = name[1]
        }
        return tags  
    }
    getPlaylistFormats(){
        return Object.keys(this.playlistFormats)
    }
	dirname(file){
        return path.dirname(file)
	}
    parseMMTags(info){
        let tags = {}
        if(info.common){
            tags = info.common
        }
        if(info.native && info.native['ID3v2.3']){ // prefer ID3v2.3 data from ID3.update()
            const map = {
                TIT2: 'title',
                TPE1: 'artist',
                TCON: 'genre',
                TORY: 'year',
                TLAN: 'language'
            }
            info.native['ID3v2.3'].forEach(row => {
                if(typeof(map[row.id]) != 'undefined'){
                    let t = map[row.id]
                    let v = row.value
                    if(v){
                        if(['title', 'year'].includes(t)){
                            tags[t] = v
                        } else {
                            v = v.split("\0").map(s => s.split(",")).flat().map(s => s.trim())
                            if(t == 'artist'){
                                tags.artist = v[0]
                                tags.artists = v
                            } else {
                                tags[t] = v
                            }
                        }
                    }
                }
            })
        }
        if(!tags.title) {
            console.error('BAD TAGS', tags, info)
        }
        return filterTags(tags)
    }
    mergeTags(a, b){
        Object.keys(b).forEach(key => {
            if(!a[key]){
                a[key] = b[key]
            }
        })
        a.artists = this.parseArtists(a)
        a.genre = this.parseGenres(a)
        return a
    }
    adjust(row){
        if(typeof(row['mood_happy']) != 'undefined' && !row['karma']){
            row.karma = this.karma(row)
        }
        row.artists = this.parseArtists(row)
        row.genre = this.parseGenres(row)
        return row
    }
    saveData(file, info){
        this.db.set(file, info, !this.server.isScanning)
    }
    time(){
        return ((new Date()).getTime() / 1000)
    }
    read(file, update){ // update: true=force update, false=new files only, undefined=update karma if needed
        return new Promise((resolve, reject) => {
            let row
            if(update !== true && this.db.has(file)){
                row = this.db.get(file)
                if(row.karma || update === false || !this.server.isScanning){
                    return resolve(row)
                }
            }
            this.queue.metadata.push(file, (err, tags) => {
                //console.warn('METADATA RETURNED, WHAT TO DO NOW?', row, this.queue.metadata.length(), this.queue.mbrainz.length())
                if(err){
                    return reject(err)
                }
                let mbrainz = (row, cb) => {
                    row = this.adjust(row) // pre adjust here for parse artists + normalize
                    this.queue.mbrainz.push(row, (err, info) => {
                        //console.warn('MBRAINZ RETURNED, WHAT TO DO NOW?', err, info)
                        if(!err && info){
                            row = this.mergeTags(row, info)
                        }
                        cb(row)
                    }).catch(console.error)
                }
                let abrainz = (row, cb) => {
                    let startTime = this.time()
                    this.queue.abrainz.push(row, (err, info) => {
                        this.queuesTimes.abrainz.push(this.time() - startTime)   
                        //console.warn('ABRAINZ RETURNED, WHAT TO DO NOW?', err, info)
                        if(!err && info){
                            row = this.mergeTags(row, info)
                        }
                        cb(row)
                    }).catch(console.error)
                    this.queue.abrainz.pump()
                }
                let finish = row => {
                    //console.warn('ABOUT TO SAVE', file, row)
                    if(row.title){
                        row = this.adjust(row)
                        //console.warn('SAVE', file, row)
                        this.saveData(file, row)
                        resolve(row)
                    } else {
                        reject('no tags to identify this song: '+ file)
                    }
                }
                if(tags['musicbrainz_recordingid']){
                    if(!Array.isArray(tags['musicbrainz_recordingid'])){
                        tags['musicbrainz_recordingid'] = [tags['musicbrainz_recordingid']]
                    }
                    abrainz(tags, tags => {
                        if(!tags.genre_rosamerica){
                            const excludes = tags['musicbrainz_recordingid'].slice(0)
                            mbrainz(tags, tags => {
                                if(tags['musicbrainz_recordingid']){
                                    tags['musicbrainz_recordingid'] = tags['musicbrainz_recordingid'].filter(id => !excludes.includes(id))
                                }
                                if(tags['musicbrainz_recordingid'] && tags['musicbrainz_recordingid'].length){
                                    abrainz(tags, tags => {
                                        finish(tags)
                                    })
                                } else {
                                    finish(tags)
                                }
                            })
                        } else {
                            finish(tags)
                        }
                    })
                } else {
                    mbrainz(tags, tags => {
                        abrainz(tags, tags => {
                            finish(tags)
                        })
                    })
                }
            }).catch(console.error)
        })
    }
    addFolderToLibrary(path){
        let libraries = this.config.get('libraries')
        if(!libraries.includes(path)){
            libraries.push(path)
            this.config.set('libraries', libraries.sort())
            return true
        }
    }
    scanDirectories(dirs, progress, newFilesOnly, requireInternet){
        return new Promise((resolve, reject) => {
            this.server.requireInternet = requireInternet
            this.server.isScanning = true
            let files = []
            const startTime = this.time()
            this.config.set('libraries', dirs)
            let scanProms = []
            dirs.forEach(dir => {
                let prom = this.readDir(dir).then(nfiles => {
                    if(Array.isArray(nfiles)){
                        nfiles = this.filterSupportedFiles(nfiles)
                        if(nfiles.length){
                            files = files.concat(nfiles)
                        }      
                    }
                }).catch(console.error)
                scanProms.push(prom)
            })
            let stats = {
                percent: 0,
                finished: 0,
                total: '?',
                startTime,
                finishTime: startTime
            }
            const timer = setInterval(() => {
                progress(stats)
            }, 1000)
            Promise.allSettled(scanProms).catch(console.error).finally(() => {
                files = [...new Set(files)]
                stats.total = files.length
                let percentVal = stats.total / 100, maxAverageTime = 0
                this.db.removeMulti(Object.keys(this.db.data).filter(file => !files.includes(file)))
                let proms = files.map(file => {
                    return this.read(file, newFilesOnly ? false : undefined).catch(console.error).finally(() => {                        
                        stats.finished++
                        if(stats.finished < stats.total){
                            let averageTime = (this.time() - startTime) / stats.finished
                            if(averageTime > maxAverageTime){
                                maxAverageTime = averageTime
                            } else {
                                averageTime = maxAverageTime
                            }
                            stats.finishTime = startTime + ((stats.total - stats.finished) * averageTime)
                            stats.percent = parseInt(stats.finished / percentVal)
                        }
                    })
                })
                Promise.allSettled(proms).catch(console.error).finally(() => {
                    this.server.requireInternet = false
                    this.server.isScanning = false
                    clearInterval(timer)
                    resolve(true)
                    this.db.save()
                })
            })
        }) 
    }
    readDir(dir) {
        return new Promise((resolve, reject) => {
            var results = []
            dir = dir.replace(new RegExp('\\\\', 'g'), '/')
            fs.readdir(dir, (err, list) => {
                if (err) {
                    return reject(err)
                }
                var pending = list.length
                if (!pending) {
                    return resolve(results)
                }
                list.forEach(file => {
                    fs.stat(dir +'/'+ file, (err, stat) => {
                        if (stat && stat.isDirectory()) {
                            this.readDir(dir +'/'+ file).then(res => {
                                results = results.concat(res)
                            }).catch(err => {
                                console.error('cannot read '+ dir +'/'+ file, err)
                            }).finally(() => {                                
                                if (!--pending){
                                    resolve(results)
                                }
                            })
                        } else {
                            results.push(dir +'/'+ file)
                            if (!--pending) { 
                                resolve(results)
                            }
                        }
                    })
                })
            })
        })
    }
    filterSupportedFiles(files){
        return files.filter(file => this.isSupported(file))
    }
    isSupported(file){
        return this.supportedExts.includes(this.ext(file))
    }
    ext(file){
        return file.split('.').pop().toLowerCase()
    }
    rename(from, to, cb){
        fs.rename(from, to, err => {
            if(err){ // fs.rename can't move across drives
                fs.copyFile(from, to, err => {
                    cb(err)
                })
            } else {
                cb(null)
            }
        })
    }
    defaultPlaylistExtension(){
        let fmt = this.config.get('playlist-format')
        if(!fmt || fmt == 'auto' || !this.playlistFormats[fmt]){
            fmt = process.platform == 'win32' ? 'm3u-latin1' : 'm3u-utf8'
        }
        return fmt.split('-').shift()
    }
    save(files, target){
        let fmt = this.config.get('playlist-format')
        if(!fmt || fmt == 'auto' || !this.playlistFormats[fmt]) {
            fmt = process.platform == 'win32' ? 'm3u-latin1' : 'm3u-utf8'
            if(typeof(target) == 'string') {
                target = target.replace(new RegExp('\\.[A-Za-z0-9]+$'), '.'+ fmt.split('-').shift())
            }
        }
        const profile = Object.assign({}, this.playlistFormats[fmt])
        const relative = this.config.get('relative-paths'), backslashes = this.config.get('backslashes')
        if(typeof(relative) == 'boolean') {
            profile.relative = relative
        }
        if(typeof(backslashes) == 'boolean') {
            profile.backslashes = backslashes
        } else {
            profile.backslashes = (process.platform == 'win32'  && name.indexOf('utf8') == -1) ? false : true
        }
        this.playlist.save(files, target, profile)
    }
    play(file){
        if(typeof(file) == 'string'){
           this.open(file, true)
        } else if(Array.isArray(file)) {
            this.save(file, file => {
                this.open(file, true)
            })
        }
    } 
    open(file, onPlayer){
        const player = onPlayer ? this.config.get('player') : 0
        if(player) {
            file = global.prepareSlashes(file)
            console.warn('OPEN', {player, file})
            require('child_process').spawn(player, [file], {
                detached: true,
                stdio: 'inherit'
            }).unref()
        } else {
            require('open')(file).catch(console.error)
        }
    } 
}

class ScannerEdit extends ScannerBase {
    constructor(opts){
        super(opts)
    }
    update(file, atts, callback){
        const tags = {
            title: atts.title,
            artist: atts.artists,
            genre: atts.genre,
            originalYear: atts.year,
            language: atts.language.split(', ').join("\0")
        }
        console.warn('ID3 UPDATE', tags, atts, file)
        fs.access(file, fs.W_OK | fs.R_OK, err0 => {
            ID3.update(tags, file, err1 => {
                let err2
                this.db.remove(file).catch(e => err2 = e).finally(() => {
                    let err3, row
                    this.read(file).then(r => row = r).catch(e => err3 = e).finally(() => {
                        let err = ''
                        if(err0) err += "\r\n"+ String(err0)
                        if(err1) err += "\r\n"+ String(err1)
                        if(err2) err += "\r\n"+ String(err2)
                        if(err3) err += "\r\n"+ String(err3)
                        callback(err, row)
                    })                
                })
            })
        })
    }
}

class ScannerSimilar extends ScannerEdit {
    constructor(opts){
        super(opts)
    }
    availableArtists(){
        let artists = []
        Object.values(this.db.data).forEach(row => {
            if(row.artists){
                artists = artists.concat(row.artists)
            }
        })
        return [...new Set(artists)]
    }
    async prepareSimilarityStruct(file){
        let info = await this.read(file)
        if(info){
            let struct = {artists: []};
            ['language', 'genre', 'karma', 'year'].concat(SIMILARITY_GENRES_ALGORITHMS).concat(SIMILARITY_RHYTHMS_ALGORITHMS).forEach(k => {
                if(info[k]){
                    struct[k] = info[k]
                }
            })
            if(info.artists){
                struct.artists = struct.artists.concat(info.artists)
            }
            struct.artists = [...new Set(struct.artists.filter(a => a))]
            return struct
        }
    }
    similarityWeights(atts){
        let k = 'similarity-weights', values = this.config.defaults[k]
        if(atts && typeof(atts) == 'object'){
            this.config.set(k, Object.assign({}, atts))
        }
        return Object.assign(Object.assign({}, values), this.config.get(k))
    }
    capArtistsPresence(scores, originalArtists, maxPresence, outputListSize){
        let nscores = [], lastPresence = {}, minDistance = Math.round(outputListSize / (maxPresence * 2))
        if(originalArtists){
            originalArtists.forEach(a => lastPresence[a] = 0)
        }
        scores.forEach((s, i) => {
            let artists = s.row.artists
            let lp = Math.max(...artists.map(a => ((typeof(lastPresence[a]) == 'undefined') ? -1 : lastPresence[a])))
            artists.forEach(a => {
                if(typeof(lastPresence[a]) == 'undefined'){
                    lastPresence[a] = i
                } else {
                    let n = lastPresence[a] + minDistance + 1
                    if(i > n){
                        lastPresence[a] = i
                    }
                }
            })
            //console.log('last presence', artists.join(','), lp, JSON.stringify(lastPresence))
            if(lp >= 0){
                let nextPresence = (lp + minDistance + 1)
                //console.log('next presence', artists.join(','), i, '=>', nextPresence)
                if(i < nextPresence){
                    let n = Math.min(outputListSize - 1, nextPresence)
                    if(n != i){
                        nscores[nextPresence] = s
                        //console.log('delayed', artists.join(','), i, '=>', nextPresence)
                        artists.forEach(a => lastPresence[a] = nextPresence)
                        return
                    }
                }
            }
            let j = 0
            while(typeof(nscores[j]) != 'undefined') j++
            nscores[j] = s
        })
        return nscores.filter(s => s) // reset keys
    }
    limitArtistsPresence(scores, maxPresence){
        let presence = {}
        scores = scores.filter(s => {
            if(s.row.artists && s.row.artists.length){
                return s.row.artists.every(artist => {
                    if(typeof(presence[artist]) == 'undefined'){
                        presence[artist] = 1
                    } else {
                        presence[artist]++
                    }
                    return presence[artist] <= maxPresence
                })
            }
        })
        return scores
    }
    generateRemoveDupKey(row){
        let key = ''
        if(row.artists && row.artists.length){
            key += row.artists[0]
        }
        if(row.title){
            key += row.title
        }
        return key
    }
    removeDups(scores, originalRow){
        let already = []
        if(originalRow){
            already.push(this.generateRemoveDupKey(originalRow))
        }
        return scores.filter(s => {
            const key = this.generateRemoveDupKey(s.row)
            const keep = !already.includes(key)
            if(keep) already.push(key)
            return keep
        })
    }
    decimals(n, cnt){
        let m = parseInt('1'+ ('0'.repeat(cnt)))
        return parseInt(n * m) / m
    }
    async findSimilars(x, y, epoch, genreTags){
        let file, fromMood, scores = [], similarityWeights = this.similarityWeights()
        const listSize = this.config.get('list-size') * 3
        if(typeof(x) == 'string'){
            let similarGenres = [], similarArtists = {}
            file = this.db.resolve(x)
            let struct = await this.prepareSimilarityStruct(file)
            if(struct.artists){
                similarArtists = await this.similarArtists(struct.artists).catch(console.error)
                struct.artists.forEach(a => similarArtists[a] = 100)
            }
            similarGenres = this.getAnyRelatedGenres(Object.keys(similarArtists).filter(a => similarArtists[a] == 100), struct.genre || [], 10)
            console.warn('SIMILARGENRES', Object.keys(similarArtists).filter(a => similarArtists[a] == 100), similarArtists, struct, similarGenres)
            similarArtists = Object.keys(similarArtists).map(artist => ({artist, score: similarArtists[artist]}))
            let similarArtistsNames = similarArtists.map(a => a.artist), gartists = this.getArtistsFromGenres(struct.year, similarGenres.score, 0.7)
            console.log('GARTISTS', gartists)
            gartists.forEach(g => {
                if(!similarArtistsNames.includes(g.artist)){
                    similarArtists.push(g)
                }
            })
            console.warn('SIMILARS', struct, similarArtists, similarGenres, struct.artists, epoch, genreTags)
            Object.keys(this.db.data).forEach(f => {
                if(f == file) return
                let row = this.db.get(f)
                if(epoch){
                    if(!row.year || row.year < epoch.from || row.year > epoch.to) return
                }
                if(genreTags && (!row.genre || !row.genre.some(g => genreTags.includes(g)))) return
                let ret = this.similarity(struct, row, similarArtists, similarGenres, similarityWeights)
                if(ret.total > 0){
                    scores.push({score: ret.total, file: f, row, scores: ret.scores})
                }
            })
        } else {
            fromMood = true
            scores = this.getByMood(x, y)
        }
        console.log('findSimilars', x, y, scores)
        scores = this.removeDups(scores, file ? this.db.get(file) : false)
        scores = scores.sort((a, b) => b.score - a.score)
        scores = this.limitArtistsPresence(scores, Math.round(listSize / 6))
        scores = scores.slice(0, listSize)
        console.log('SCORES', scores.slice(0))
        let originalArtists
        if(file) originalArtists = this.db.data[file].artists
        scores = this.capArtistsPresence(scores, originalArtists, Math.round(listSize / 12), listSize)
        console.log('SCORES', scores.slice(0))
        let log = {}
        scores.forEach(s => {
            log[s.file] = this.opts.lang.FILE +': '+ s.file.split('/').pop() +"\r\n"
            s.scores.sort((a, b) => b.score - a.score).forEach(r => {
                log[s.file] += r.reason
                if(r.score) log[s.file] += ' (+'+ this.decimals(r.score, 3) +'pts)'
                log[s.file] += "\r\n"
            })
            log[s.file] += this.opts.lang.TOTAL +': '+ this.decimals(s.score, 3) +"pts\r\n"
        });
        let files = scores.map(s => s.file)
        if(file) files.unshift(file)
        return {files, log, karmas: files.map(file => this.db.get(file).karma)}
    }
    async findFromEpoch(epoch, genreTags){
        let file, scores = [], similarityWeights = this.similarityWeights()
        const listSize = this.config.get('list-size') * 3
        console.warn('FROM EPOCH', epoch, genreTags)
        Object.keys(this.db.data).forEach(f => {
            if(f == file) return
            let row = this.db.get(f)
            if(epoch){
                if(!row.year || row.year < epoch.from || row.year > epoch.to) return
            }
            if(genreTags && (!row.genre || !row.genre.some(g => genreTags.includes(g)))) return
            let reasons = [
                {reason: this.opts.lang.YEAR +': '+ row.year, score: 1}
            ]
            if(genreTags){
                reasons.push({reason: this.opts.lang.GENRE_TAGS +': '+ row.genre.filter(g => genreTags.includes(g)).join(', '), score: 1})
            }
            scores.push({score: 1, file: f, row, scores: reasons})
        })
        console.log('findFromEpoch', scores)
        scores = this.removeDups(scores, file ? this.db.get(file) : false)
        //scores = scores.sort((a, b) => b.score - a.score)
        scores = scores.slice(0, listSize)
        console.log('SCORES', scores.slice(0))
        let originalArtists
        if(file) originalArtists = this.db.data[file].artists
        scores = this.capArtistsPresence(scores, originalArtists, Math.round(listSize / 12), listSize)
        console.log('SCORES', scores.slice(0))
        let log = {}
        scores.forEach(s => {
            log[s.file] = this.opts.lang.FILE +': '+ s.file.split('/').pop() +"\r\n"
            s.scores.sort((a, b) => b.score - a.score).forEach(r => {
                log[s.file] += r.reason
                if(r.score) log[s.file] += ' (+'+ this.decimals(r.score, 3) +'pts)'
                log[s.file] += "\r\n"
            })
            log[s.file] += this.opts.lang.TOTAL +': '+ this.decimals(s.score, 3) +"pts\r\n"
        });
        let files = scores.map(s => s.file)
        if(file) files.unshift(file)
        return {files, log, karmas: files.map(file => this.db.get(file).karma)}
    }
    getEpochRange(){
        const years = Object.values(this.db.data).map(r => r.year).filter(s => s)
        if(!years.length) return {min: 0, max: 0}
        let min = Math.min(...years)
        let max = Math.max(...years)
        return {min, max}
    }
    similarity(a, b, similarArtists, similarGenres, similarityWeights){
        let scores = []
        let artistSimilarity = {score: 0, artist: ''}
        if(b.artists){
            b.artists.forEach(a => {
                similarArtists.some(r => {
                    if(r.artist == a){
                        if(r.score > artistSimilarity.score){
                            artistSimilarity = r
                        }
                    }
                })
            })
        }

        /* START - keep this block as it will be used for genre and rhythm */
        const deepGenres = SIMILARITY_GENRES_ALGORITHMS
        let genreSimilarity = b.genre ? b.genre.map(g => (similarGenres.score[g] || 0)).sum() : 0
        genreSimilarity = genreSimilarity / (similarGenres.total / 100)
        let similarGenre = b.genre ? b.genre.filter(g => similarGenres.genres.includes(g)).join('+') : ''
        
        if(!similarGenre){
            if(deepGenres.every(type => {
                if(a[type] && b[type]){
                    if(a[type].value == b[type].value && a[type].probability > 0.5 && b[type].probability > 0.5){
                        return true
                    }
                }
            })){
                similarGenre = deepGenres.map(type => a[type].value).join('+')
            }
        }

        let ay = a.year, by = b.year
        if(ay && by && similarityWeights.year){
            let diff = Math.abs(ay - by)
            if(diff < 10){
                scores.push({score: (10 - diff) * (similarityWeights.year / 10), percent: 100 - (diff * 10), reason: this.opts.lang.YEAR +': '+ay+'|'+by})
            }
        }

        if(a.language && b.language && similarityWeights.language){
            if(a.language.some(l => b.language.includes(l))){
                scores.push({score: similarityWeights.language, percent: 100, reason: this.opts.lang.LANGUAGE +': '+ b.language.join(', ')})
            }
        }
        
        if(a.karma && b.karma && similarityWeights.mood){
            let s = this.compareMoods(a, b)
            if(s > 80){
                scores.push({score: (s - 80) * (similarityWeights.mood / 20), percent: s, reason: this.opts.lang.MOOD +': '+ this.decimals(s, 3)})
            }
        }

        if(similarityWeights.genre && genreSimilarity){
            scores.push({score: genreSimilarity * (similarityWeights.genre / 100), percent: genreSimilarity, reason: this.opts.lang.GENRE_TAGS +': '+ parseInt(genreSimilarity) + ' ('+ similarGenre +')'})
        }

        SIMILARITY_GENRES_ALGORITHMS.concat(SIMILARITY_RHYTHMS_ALGORITHMS).forEach(t => {
            let minSimilarityPercent = 60
            if(similarityWeights[t] && (similarGenre || (artistSimilarity.score > 50))){
                let score = this.compareMetrics(t, a, b)

                let deepGenreScore = 0, deepGenreScoreCount = 0
                deepGenres.forEach(type => {
                    if(a[type] && b[type]){
                        let sim = this.compareMetrics(type, a, b)
                        if(sim != null){
                            deepGenreScore += sim
                            deepGenreScoreCount++
                        }
                    }
                })
                if(score > minSimilarityPercent){
                    let pts = 100 - minSimilarityPercent, quota = similarityWeights[t] / pts
                    scores.push({score: (score - minSimilarityPercent) * quota, percent: score, reason: t +': '+ this.decimals(score, 3)})
                }
            }
        })

        if(similarityWeights.genreDetect && (similarGenre || (artistSimilarity.score > 50))){
            let deepGenreScore = 0, deepGenreScoreCount = 0
            deepGenres.forEach(type => {
                if(a[type] && b[type]){
                    let sim = this.compareMetrics(type, a, b)
                    if(sim != null){
                        deepGenreScore += sim
                        deepGenreScoreCount++
                    }
                }
            })
            if(deepGenreScoreCount){
                deepGenreScore /= deepGenreScoreCount
                let minSimilarityPercent = 60
                if(deepGenreScore > minSimilarityPercent){
                    let pts = 100 - minSimilarityPercent, quota = similarityWeights.genreDetect / pts
                    scores.push({score: (deepGenreScore - minSimilarityPercent) * quota, percent: deepGenreScore, reason: this.opts.lang.GENREDETECT +': '+ this.decimals(deepGenreScore, 3)})
                }
            }
        }

        if(similarityWeights.similarArtist){
            if(Object.values(similarityWeights).filter(v => v > 0).length == 1){ // artist similarity only
                scores.push({score: artistSimilarity.score / 100, percent: artistSimilarity.score, reason: this.opts.lang.SIMILARARTIST +': '+ this.decimals(artistSimilarity.score, 3)})
            } else {
                let multiplier = 1 - (((100 - artistSimilarity.score) * similarityWeights.similarArtist) / 100)
                scores = scores.map(s => {
                    s.score *= multiplier
                    return s
                })
                let reason = this.opts.lang.SIMILARARTIST +': '+ this.decimals(multiplier, 3) +'x'
                if(artistSimilarity.artist){
                    reason += ' ('+ artistSimilarity.artist +')'
                }
                scores.push({score: 0, reason})
            }
        }

        let total = 0
        scores.forEach(s => total += s.score)        

        return {total, scores}
    }
    compareMoods(a, b){
        if(a.karma && b.karma){
            let distance = this.distance(100 - b.karma[1], b.karma[0], 100 - a.karma[1], a.karma[0])
            let maxDistance = Math.hypot(-100, 100)
            return 100 - (distance / (maxDistance / 100))
        } else {
            return 0
        }
    }
    compareMetrics(type, a, b){
        if(!a[type] || !b[type]) return 0
        const cats = this.topMetrics(a[type].all, 2)
        const _a = this.normalizeMetrics(a[type].all, cats), _b = this.normalizeMetrics(b[type].all, cats)
        let diffs = cats.map(cat => Math.abs(_a[cat] - _b[cat]))
        return 100 - (diffs.sum() / cats.length)
    }
    topMetrics(a, count){
        let scores = []
        Object.keys(a).forEach(cat => scores.push({cat, score: a[cat]}))
        return scores.sort((b, c) => c.score - b.score).slice(0, count).map(g => g.cat)
    }
    normalizeMetrics(a, cats){
        let ret = Object.assign({}, a)
        let max = cats.map(cat => a[cat]).sum() / 100
        cats.forEach(cat => ret[cat] = parseInt(ret[cat] / max))
        return ret
    }
}

class ScannerSimilarArtists extends ScannerSimilar {
    constructor(opts){
        super(opts)
        this.similarArtistsLimit = 40
    }
    async similarArtists(artists){
        let foundArtists = {}
        artists.forEach(artist => {
            let nartists = this.localSimilarArtists(artist)
            nartists.forEach(a => {
                if(!artists.includes(a) && typeof(foundArtists[a]) == 'undefined'){
                    foundArtists[a] = 100
                }
            })
        })
        if(Object.keys(foundArtists).length < this.similarArtistsLimit){
            let availableArtists = this.availableArtists()
            let nas = await this.server.similarArtists(artists).catch(console.error)
            if(nas && typeof(nas) == 'object'){
                Object.keys(nas).forEach(artist => {
                    if(availableArtists.includes(artist) && !artists.includes(artist) && typeof(foundArtists[artist]) == 'undefined'){
                        foundArtists[artist] = 100 - (nas[artist] * 10)
                    }
                })
            }
        }
        return foundArtists
    }
    localSimilarArtists(artist, amount=40, excludes=null){
        let artists = []
        if(!Array.isArray(excludes)){
            excludes = []
        }
        if(!excludes.includes(artist)){
            excludes.push(artist)
        }
        Object.keys(this.db.data).filter(file => {
            let row = this.db.get(file)
            if(row.artists && row.artists.includes(artist)){
                artists = artists.concat(row.artists.filter(a => a && !excludes.includes(a)))
            }
        })
        if(artists.length < amount){
            artists.slice(0).some(a => {
                if(!excludes.includes(a)){
                    let nas = this.localSimilarArtists(a, amount - artists.length, artists.concat(excludes))
                    artists = artists.concat(nas)
                }
                return artists.length >= amount
            })
        }
        return artists
    }
}

class Scanner extends ScannerSimilarArtists {
    constructor(opts){
        super(opts)
        this.onLine = false
        this.server = new SongtripServerClient(storage)
        this.cloud = new Cloud(storage)
    }
    async getCloudConfig(){
        if(!this.cloudConfig || !Object.keys(this.cloudConfig).length){
            this.cloudConfig = await this.cloud.get('configure')
        }
        return this.cloudConfig
    }
    setInternetConnState(state){
        this.onLine = state
        this.server.setInternetConnState(state)
    }
    sleep(ms){
        return new Promise((resolve, reject) => {
            setTimeout(resolve, ms)
        })
    }
    async getHelp(){
        let configs = await this.getCloudConfig()
        let url = configs['help'].replace('[locale]', this.opts.lang.locale)
        require('open')(url)
    }
    async waitInternetConnection(){
        while(!this.onLine){
            await this.sleep(200)
        }
        return true
    }
    async checkUpdates(){
        const currentVersion = require(process.cwd() +'/package.json').version
        const configs = await this.getCloudConfig()
        return currentVersion < configs['version']
    }
}

module.exports = Scanner
