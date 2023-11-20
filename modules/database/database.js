const Events = require('events'), fs = require('fs'), path = require('path')

class Database extends Events {
    constructor(file){
        super()
        this.rawData = []
        this.data = {}
        this.file = file
        this.load()
    }
    load(){
		fs.stat(this.file, (err, stat) => {
			if(err){
                console.log('x', err)
				fs.mkdir(path.dirname(this.file), {recursive: true}, (err) => {
					if (err){
						console.error(err)
					}
                    fs.writeFileSync(this.file, '')
                    this.isReady = true
                    this.emit('ready')
				})
			} else {
				fs.readFile(this.file, (err, data) => {
                    if(err){
                        data = ''
                    }
                    this.rawData = String(data).split("\n")
                    let tempJSON = []
                    let files = []
                    this.rawData.forEach(line => {
                        let pos = line.indexOf("\0")
                        if(pos != -1){
                            let file = this.resolve(line.substr(0, pos))
                            let row = line.substr(pos + 1)
                            files.push(file)
                            tempJSON.push(row)
                        }
                    });
                    tempJSON = '['+ tempJSON.join(',') +']'
                    let rows = JSON.parse(tempJSON)
                    rows.forEach((row, i) => {
                        this.data[files[i]] = row
                    })

                    console.log('x', tempJSON)
                    this.checkDriveChange().catch(console.error).finally(() => {
                        this.isReady = true
                        this.emit('ready')
                    })
                })
			}
		})
    }
    ready(){
        return new Promise((resolve, reject) => {
            if(this.isReady){
                resolve()
            } else {
                this.once('ready', resolve)
            }
        })
    }
	has(file){
		return typeof(this.data[this.resolve(file)]) != 'undefined'
	}
	get(file){
        return this.data[this.resolve(file)]
	}
    resolve(file){
        if(file.indexOf('\\') != -1){
            file = file.replace(new RegExp('\\\\', 'g'), '/')
        }
        return file
    }
    async remove(key){
        let ret = await this.removeMulti([key])
        return ret
    }
    async removeMulti(keys){
        let removed = 0
        await this.ready()
        for(const key of keys){
            let i = Object.keys(this.data).indexOf(key)
            if(i != -1){
                delete this.data[key]
                this.rawData.splice(i, 1)
                removed++
            }
        }
        if(removed){
            await this.save()
        }
        return removed
    }
	async set(file, data, save=true){
        await this.ready()
        file = this.resolve(file)
        let row = file +"\0"+ JSON.stringify(data) +"\n", append = typeof(this.data[file]) == 'undefined'
        this.data[file] = data
        if(append){ // append
            this.rawData.push(row)
            if(save) fs.appendFileSync(this.file, row)
        } else {
            let i = Object.keys(this.data).indexOf(file)
            this.rawData[i] = row
            if(save) this.save()
        }
	}
	async save(){
        await this.ready()
		return fs.writeFileSync(this.file, this.rawData.join("\n")) // write sync to prevent corruption and loss of data
	}
    getDriveLetter(file){
        if(String(file).charAt(1) == ':'){
            return String(file).charAt(0)
        }
    }
    async checkDriveChange(){
        let drives = []
        let usbDriveLetter = this.getDriveLetter(process.execPath)
        console.log(usbDriveLetter, Object.keys(this.data))
        for(let file in this.data){
            let letter = this.getDriveLetter(file)
            if(letter && letter != usbDriveLetter && !drives.includes(letter)){
                drives.push(letter)
                console.log(letter, usbDriveLetter, file)
                let ret = await this.checkDriveChangeFile(file, usbDriveLetter)
                if(ret) this.fixDriveLetter(ret)
            }
        }
        return
    }
    async checkDriveChangeFile(file, usbDriveLetter){
        let exists = fs.existsSync(file)
        if(exists) return
        let ufile = usbDriveLetter + file.substr(1)
        if(!fs.existsSync(file) && fs.existsSync(ufile)){
            return {
                from: this.getDriveLetter(file),
                to: usbDriveLetter
            }
        }
    }
    fixDriveLetter(drives){
        console.log(drives, Object.keys(this.data))
        for(let file in this.data){
            let letter = this.getDriveLetter(file)
            console.log(file, letter)
            if(letter == drives.from){
                const ufile = drives.to + file.substr(1)
                this.data[ufile] = this.data[file]
                delete this.data[file]
                console.log(file, ufile)
            }
        }
        console.log(drives, Object.keys(this.data))
    }
    sort(){
        const vals = {}, ndb = {}, nrd = []
        Object.keys(this.data).forEach((file, i) => {
            const r = this.data[file], sortKey = ('-' + r.artist + r.title + file.split('/').pop()).toUpperCase()
            if(typeof(vals[sortKey]) == 'undefined') vals[sortKey] = {}
            vals[sortKey][file] = this.rawData[i]
        })
        Object.keys(vals).sort().forEach(k => {
            Object.keys(vals[k]).forEach(file => {
                ndb[file] = this.data[file]
                nrd.push(vals[k][file])
            })
        })
        this.data = ndb
        this.rawData = nrd
    }
}

module.exports = Database
