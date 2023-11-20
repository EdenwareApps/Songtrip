const fs = require('fs'), path = require('path')

class Playlist {
    constructor(opts){
        Object.keys(opts).forEach(k => {
            this[k] = opts[k]
        })
    }
    ext(file){
        return file.toLowerCase().split('.').pop()
    }
	slashify(file, forward){
        let prepend = '', s = file.match('^[a-z]+:[\\/]+'), f = file
        if(s){ // protocols
            prepend = s[0]
            f = f.substr(s[0].length)
        } else {
            s = f.substr(0, 2)
            if(s == '\\' || s == '//'){ // network path
                prepend = s
                f = f.substr(2)
            }
        }
        if(forward){
		    f = f.replaceAll('\\', '/').replaceAll('//', '/')
        } else {
		    f = f.replaceAll('/', '\\').replaceAll('\\\\', '\\')
        }
        return prepend + f
	}
	relativize(file, base){
        console.warn('RELATIVIZE', file, base, path.relative(base, file))
        return path.relative(base, file)
	}
    winEncode(txt){
       if(!this.windows1252){
            this.windows1252 = require('modules/windows-1252')
       }
       return this.windows1252.encode(txt, {mode: 'fatal'})
    }
    process(files, opts){
        console.log('process', files, opts)
        return files.map(file => {
            try{
                let f = file, n = file.split('/').pop()
                n = n.replace(new RegExp('\.(A-Za-z0-9]{1,4})$', 'i'), '')
                if(opts.relative){
                    f = this.relativize(f, opts.targetDir)
                }
                if(!opts.backslashes){
                    f = this.slashify(f, false)
                }
                if(!opts.utf8){
                    f = this.winEncode(f) // wmp, latin1 isn't enough
                    n = this.winEncode(n) // wmp, latin1 isn't enough
                }
                return {f, n}
            } catch(e) {
                console.error(e)
            }
        }).filter(s => s)
    }
    async m3u(files, target, opts){
        let m3u = ['#EXTM3U'], tempFile = opts.targetDir +'/temp.'+ opts.fmt
        this.process(files, opts).forEach(row => {
            try{
                let {f, n} = row
                let add = [
                    "\n",
                    f
                ]
                if(opts.extinf){
                    add = [
                        "\n#EXTINF:0,", 
                        n
                    ].concat(add)
                    add.push("\n")
                }
                m3u = m3u.concat.apply(m3u, add)
            } catch(e) {
                console.error(e)
            }
        })
        m3u = m3u.map(b => {
            if(!Buffer.isBuffer(b)){
                b = Buffer.from(b)
            }
            return b
        })
        await fs.promises.mkdir(opts.targetDir, {recursive: true})
        await fs.promises.writeFile(tempFile, Buffer.concat(m3u), opts.utf8 ? 'utf8' : 'latin1')
        if(typeof(target) == 'function'){
            target(tempFile)
        } else if(typeof(target) == 'string'){
            await fs.promises.copyFile(tempFile, target)
        }
    }
    save(files, target, opts){
        opts.targetDir = typeof(target) == 'string' ? path.dirname(target) : this.paths.temp
        this[opts.fmt](files, target, opts)
    }
}

module.exports = Playlist
