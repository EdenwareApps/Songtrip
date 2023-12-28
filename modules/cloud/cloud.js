
const Client = require('../client')

class CloudData extends Client {
    constructor(storage){
        super('http://edenware.app/songtrip', storage)
        this.debug = false
        this.expires = {
            configure: 3600
        }
    }
}

module.exports = CloudData
