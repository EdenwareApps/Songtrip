const path = require('path'), fs = require('fs')
const loadLanguage = require('./modules/lang'), Countries = require('./modules/countries')
const langs = require('langs'), bytenode = require('bytenode'), Scanner = require('./modules/scanner/scanner')

var paths, serverOnLine = true
if(fs.existsSync('./.portable')){
    let dir = fixpath(process.cwd()) +'/.portable'
    paths = {
        data: dir +'/data',
        temp: dir +'/temp'
    }
    Object.values(paths).map(p => {
        if(!fs.existsSync(p)) fs.mkdirSync(p, {recursive: true})
    })
} else {
    paths = require('env-paths')('Songtrip', {suffix: ''})
}

countries = new Countries()
require('modules/supercharge')(global)

require('fs').stat('.development', (err, stat) => { // disable console on production
    if(err){
        let fns = ['log', 'warn']
        fns.forEach(f => { global.console[f] = console[f] = () => {}})
    }
})

var epoch = null

function chooseFile(cb){
    openFileDialog(cb, 'audio/*')
}

function chooseFolder(cb){
    saveFolderDialog(folder => {
        if(folder){
            cb(folder)
        }
    })
}

function theme(colorA, colorB){
    if(colorA.charAt(0)=='#') colorA = hexToRgb(colorA)
    if(colorB.charAt(0)=='#') colorB = hexToRgb(colorB)
    let mainColor = colorMixer(rgb2arr(colorA), [255,255,255], 0.65)
    let mainColorShadow = colorA
    let secondaryColor = colorMixer(rgb2arr(colorB), [255,255,255], 0.6)
    let secondaryColorShadow = colorB
    let buttonColor = colorMixer(rgb2arr(colorA), [0,0,0], 0.1)
    let buttonColorShadow = colorMixer(rgb2arr(buttonColor), [255,255,255], 0.2)
    buttonColor = colorMixer(rgb2arr(buttonColor), [255,255,255], 0.025)
    css(`
    :root {
        --main-color: ${mainColor};
        --main-color-shadow: ${mainColorShadow};
        --button-main-background: ${buttonColor};
        --button-main-shadow: ${buttonColorShadow};
        --button-secondary-background: ${secondaryColor};
        --button-secondary-shadow: ${secondaryColorShadow};
    }
    `, 'theme')
}

function buildThemeSelector(){
    const c = document.getElementById('theme-select')
    const themes = ['#00090A-#3C4148','#01686f-#a34424','#0D0C0E-#760538','#00585f-#760538','#021840-#106784','#8a0073-#64219C']
    let html = themes.map(t => {
        const p = t.split('-')
        return `
<span class="theme-option" style="background: linear-gradient(to right, ${p[0]} 49.99%, ${p[1]} 50%);" onclick="setTheme('${t}')"></span>
`
    }).join('')
    c.innerHTML = html
}

function updateTheme(){
    let colorA = jQuery('#theme-main-color').val()
    let colorB = jQuery('#theme-secondary-color').val()
    scanner.config.set('theme', colorA +'-'+ colorB)
    theme(colorA, colorB)
}

function loadTheme(){
    let def = scanner.config.get('theme')
    console.log('def theme', def)
    let opts = document.querySelectorAll('#theme-select option')
    Array.from(opts).some((e, i) => {
        if(!def || def.indexOf('-') == -1 || def == e.value || i == (opts.length - 1)){
            console.log('def theme', def, e.value, i)
            e.parentNode.selectedIndex = i
            if(!def){
                def = e.value
            }
            let colors = def.split('-')
            jQuery('#theme-main-color').val(colors[0])
            jQuery('#theme-secondary-color').val(colors[1])
            return true
        }
    })
    buildThemeSelector()
}

function setTheme(v){
    if(!v) return
    colors = v.split('-')
    jQuery('#theme-main-color').val(colors[0])
    jQuery('#theme-secondary-color').val(colors[1])
    updateTheme()
}

function notify(txt, ms, cb){
    const options = {
        icon: './default_icon.png',
        body: txt
    }
    const notification = new Notification('', options)
    notification.onclick = () => {
        restoreFromTray()
        require('nw.gui').Window.get().focus()
        cb && cb()
    }
    notification.onshow = () => {
        document.querySelector('audio#warn').play()
        setTimeout(() => notification.close(), ms || 4000)
    }
}

var uiLibraryFolders = []

function addLibraryFolder(folder){
    jQuery('div#library-setup-results').html('')
    folder = fixpath(folder)
    let cfolder = folder
    if(cfolder.charAt(cfolder.length - 1) != '/'){
        cfolder += '/'
    }
    let has = uiLibraryFolders.some(l => {
        let lfolder = l
        if(lfolder.charAt(lfolder.length - 1) != '/'){
            lfolder += '/'
        }
        console.log(cfolder.substr(0, lfolder.length), lfolder)
        if(cfolder.substr(0, lfolder.length) == lfolder){
            return true
        }
    })
    if(!has){
        uiLibraryFolders.push(folder)
        jQuery('<div class="library-folder"><span>'+ folder +'</span><button class="remove library-setup-remove" title="'+ lang.REMOVE +'"><i class="fas fa-times" /></button></div>').on('click', () => removeLibraryFolder(folder)).appendTo('#library-folders')
        updateLibraryFolderLayout()
        return true
    }
}

function removeLibraryFolder(folder){
    folder = fixpath(folder)
    jQuery('div#library-setup-results').html('')
    let i = uiLibraryFolders.indexOf(folder)
    if(i != -1){
        uiLibraryFolders.splice(i, 1)
        jQuery('#library-folders .library-folder').eq(i).remove()
    }
    updateLibraryFolderLayout()
}

function lockLibraryControls(){
    jQuery('#library-setup-controls').addClass('lock')
}

function unlockLibraryControls(){
    if(navigator.onLine) jQuery('#library-setup-controls').removeClass('lock')
}

function updateLibraryFolderLayout(){
    jQuery('#library-folders .library-folder').each((i, e) => {
        if(i % 2){
            jQuery(e).removeClass('even').addClass('odd')
        } else {
            jQuery(e).removeClass('odd').addClass('even')
        }
    })
}

function checkSetupMandatory(){
    let mandatory = !uiLibraryFolders.length || jQuery('#main-container-left-items .main-container-item-center').length
    let backBt = jQuery('#main-container-left-header #mobile-back-icon')
    if(mandatory){
        backBt.hide()
    } else {
        backBt.show()
    }
    return mandatory
}

function updateLibraryConnStatus(){
    let s = jQuery('div#library-setup-results')
    if(navigator.onLine){
        let html = s.html()
        if(html.indexOf('fa-exclamation-triangle') != -1){
            s.html('')
        }
    } else {
        s.html('<span style="color: rgb(90, 6, 25);"><i class="fas fa-exclamation-triangle"></i> '+ lang.NO_INTERNET_CONNECTION +'</span>')
    }
}

function enterLibrarySetup(){
    hideLibrarySetupScanHint()
    checkSetupMandatory()
    if(uiLibraryFolders.length){
        jQuery('#library-setup-welcome').hide()
        jQuery('#library-setup-common').show()
    } else {
        jQuery('#library-setup-welcome').show().find('p').html(lang.WELCOME_INFO.format(lang.SAVE))
        jQuery('#library-setup-common').hide()
    }
    jQuery('html').addClass('library-setup')
    updateLibraryConnStatus()
}

function leaveLibrarySetup(){
    if(!checkSetupMandatory()){
        jQuery('html').removeClass('library-setup')
        jQuery('div#library-setup-results').html('')
        jQuery('.main-container-filter input[type="text"]').trigger('focus')
    }
}

function showLibrarySetupScanHint(){
    jQuery('div#library-setup-common').hide()
    jQuery('div#library-setup-controls').hide()
    jQuery('div#library-setup-wait').show()
}

function hideLibrarySetupScanHint(){
    jQuery('div#library-setup-common').show()
    jQuery('div#library-setup-controls').show()
    jQuery('div#library-setup-wait').hide()
}

async function scanLibraries(newFilesOnly){
    window.isScanning = true
    let requireInternet = checkSetupMandatory()
    lockLibraryControls()
    let ttotal = 0, scanningTpl = '<span align="center">'+ lang.SCANNING +': {0}% &middot; {1}/{2} '+ lang.FILES.toLowerCase() +'</span>'
    showLibrarySetupScanHint()
    let wrapper = jQuery('div#library-setup-results')
    wrapper.html(`
    <div>
        <i class="fas fa-circle-notch fa-spin"></i> 
        {0}
    </div>`.format(scanningTpl.format(0, 0, '?', '?')))
    let cont = wrapper.find('span')
    await scanner.scanDirectories(uiLibraryFolders, stats => {
        if(!navigator.onLine) return
        if(!ttotal) ttotal = stats.total
        //let remainingTime = ((stats.finishTime - stats.startTime) * 1000)
        //remainingTime = lang.WILL_BE_READY +' '+ moment((new Date()).getTime() - remainingTime).toNow().toLowerCase()
        cont.html(scanningTpl.format(stats.percent, stats.finished, stats.total))
    }, newFilesOnly, requireInternet).catch(err => {
        wrapper.html('<pre>'+ String(err) +'</pre>')
    })
    window.isScanning = false
    hideLibrarySetupScanHint()
    wrapper.html(`
    <div>
        <i style="color: #00866e;" class="fas fa-check-circle"></i> 
        <span style="color: #00866e;">${lang.FINISHED}</span>
    </div>
    `)
    await renderLibrary()
    unlockLibraryControls()
    if(!newFilesOnly){
        notify(lang.SCAN_FINISHED, 5000, () => {
            leaveLibrarySetup()
            setView(0)
        })
    }
    if(!checkSetupMandatory()){
        setTimeout(leaveLibrarySetup, 4000)
    }
    setupEpochView()
}

async function play(){
    scanner.play(currentGeneratedPlaylist())
}

function rowTitle(row, file){
    let title = ''
    if(row.artist && row.title){
        title = row.artist +' &middot; '+ row.title
    } else {
        title = file.split('/').pop().split('.').slice(0, -1).join('')
    }
    if(title.indexOf('"') != -1){
        title = title.replaceAll('"', '&quot;')
    }
    return title
}

function fileTitle(file){
    let row = scanner.db.get(file)
    return rowTitle(row, file)
}

function currentGeneratedPlaylist(){
    return jQuery('#main-container-right-header .main-container-text[data-file], #main-container-right .main-container-item').map((i, e) => {
        let file = e.getAttribute('data-file')
        if(file){
            file = Buffer.from(file, 'base64').toString()
            return file
        }
    }).filter((i, s) => s).toArray()
}

function handleArgs(args, cb){
    const file = fileFromArgs(args)
    if(file){
        console.log('processing args', file, cb)
        return generate(file, basename(file, true), true).catch(console.error).finally(cb)
    }
    cb()
}

var generating, lastGenerate, lastGenerateExcludes = [], lastGenerateParams = null, delayedGenerateTimer = 0
function delayedGenerate(){
    clearTimeout(delayedGenerateTimer)
    delayedGenerateTimer = setTimeout(() => generate(), 400)
}
function delayedGenerateEpoch(){
    clearTimeout(delayedGenerateTimer)
    delayedGenerateTimer = setTimeout(() => generateEpoch(), 400)
}
async function watch(files){
    let videoUrls
    videoUrls = await scanner.vsPlaylist(files)
    console.warn('VIDEOURL', videoUrls)
    jQuery('body').addClass('embed-video')
    document.querySelector('#vplayer iframe').contentWindow.play(videoUrls)
}
function renderResultItem(file) {    
    let row = scanner.db.get(file)
    let title = [row.title, row.artist].filter(s => s)
    if(title.length){
        title = title.join(' - ')
    } else {
        title = file.split('/').pop()
    }
    return '<li class="main-container-item" '+
        ' data-file="'+ Buffer.from(file).toString('base64') +'" title="'+ title +'"><span class="main-container-text">'+ row.title +
        '<span class="main-container-text-artist"> &middot; '+ row.artist +'</span></span>' +
        '<span class="main-container-action main-container-action-remove" title="'+ lang.REMOVE +'"><i class="fas fa-times"></i></span>' +
    '</li>'
}
async function generate(file, title, doPlay){
    if(generating) return
    generating = true
    let x, y, fromMood, result = jQuery('#main-container-right-items')
    if(typeof(file) == 'undefined'){
        if(lastGenerateParams){
            file = lastGenerateParams[0]
            title = lastGenerateParams[1]
        } else {
            generating = false
            return
        }
    } else {
        lastGenerateParams = [file, title]
    }
    setView(-1)
    let header = jQuery('#main-container-right-header'), headerMobile = jQuery('#main-container-right-header-mobile')
    let headerTitle, headerMobileTitle, headers = header.add(headerMobile)
    result.html('<li class="main-container-item main-container-item-center" align="center"><img src="assets/images/icon.png" class="loading" style="width: 17.5vh;" title="'+ lang.GENERATING +'"></li>')
    if(typeof(file) == 'number'){
        fromMood = true
        x = file
        y = title
        headerTitle = '<span class="main-container-text">'+ lang.HAPPY +': '+ Math.round(x) +'% &middot; '+ lang.ENERGY +': '+ Math.round(y) +'%</span>'
        headerMobileTitle = '<span class="main-container-text">'+ lang.HAPPY +': '+ Math.round(x) +'% &middot; '+ lang.ENERGY +': '+ Math.round(y) +'%</span>'
    } else {
        headerTitle = headerMobileTitle = '<span class="main-container-text" data-file="'+ Buffer.from(file).toString('base64') +'">'
        headerMobileTitle += title.split(String.fromCharCode(183)).pop() +'</span>'
        headerTitle += title +'</span>'
    }
    header.html(headerTitle)
    headerMobile.html('<a href="#" id="mobile-back-icon" class="main-container-action main-container-action-about button-transparent" onclick="setView(0)"><i class="fas fa-chevron-left"></i></a>'+ headerMobileTitle)
    setTimeout(async () => {
        let ret = await scanner.findSimilars(file, title).catch(err => {
            console.error(err)
            result.html('<li class="main-container-item main-container-item-center main-container-item-red" align="center">'+ err +'</li>')
            if(popupMode) popupLoader.window.alert(String(err))
        })
        generating = false;
        if(ret){
            console.log('generate', ret, x, y, file, title)
            lastGenerate = ret
            lastGenerateExcludes = []
            if(!popupMode){
                let mcr = jQuery('#main-container-right')
                let result = jQuery('#main-container-right-items')
                mcr.hide()
                const els = scanner.config.get('list-size')
                let html = '', ls = Math.min(els, ret.files.length)
                if(ret.files.length > 1){
                    jQuery('<a href="#" class="main-container-action button-transparent" title="'+ lang.WATCH_ALL +'"><i class="fas fa-film"></i></a>').appendTo(headers).on('click', () => {
                        watch(currentGeneratedPlaylist())
                    })
                    jQuery('<a href="#" class="main-container-action button-transparent" title="'+ lang.SAVE +'"><i class="fas fa-save"></i></a>').appendTo(headers).on('click', () => {
                        let name = title
                        let ext = scanner.defaultPlaylistExtension()
                        if(fromMood){
                            name = (lang.HAPPY +'-'+ Math.round(x) +'-'+ lang.ENERGY +'-'+ Math.round(y)).toLowerCase()
                        }
                        name = 'Songtrip - '+ name
                        saveFileDialog(file => {
                            if(file) scanner.save(currentGeneratedPlaylist(), file)
                        }, name +'.'+ ext)
                    })
                    if(!listGeneratedInfoLearned){
                        html += '<li class="main-container-item main-container-item-register" style="line-height: 150%; cursor: default; padding: var(--density-05x);"><div>'+ lang.LIST_GENERATED_INFO.format('<i class="fas fa-info-circle"></i>', '<i class="fas fa-times"></i>', lang.PLAY.toUpperCase())
                        html += '<span title="OK" style="display: block; margin: 0.5em 0;" class="button-main" onclick="listGeneratedInfoOK(this)"><i class="fas fa-check"></i> OK</span></div></li>'
                    }
                    for(let i=(fromMood ? 0 : 1);i<ls; i++){
                        html += renderResultItem(ret.files[i])
                    }
                }
                jQuery('<span class="main-container-action play-button button-secondary" title="'+ lang.PLAY +'"><i class="fas fa-play"></i><span> '+ lang.PLAY +'</span></span>').appendTo(headers).on('click', () => {
                    play()
                })
                result.html(html)
                mcr.show()
                result.scrollTop(0)
                if(ls < els){
                    if(serverOnLine){
                        let row = scanner.db.data[file]
                        if(row && !row.karma){
                            jQuery('<li class="main-container-item main-container-item-warn" title="'+ lang.EDIT_INSUFFICIENT_INFO_CLICK +'"><i class="fas fa-exclamation-circle"></i> '+ lang.EDIT_INSUFFICIENT_INFO_CLICK +'</li>').on('click', e => {
                                let b64 = Buffer.from(file).toString('base64')
                                editSong(b64)
                                e.preventDefault()
                                e.stopPropagation()
                            }).prependTo(result)
                        }
                    }
                }
            }
            if(ret.files.length <= 1 && popupMode){
                popupLoader.window.alert(lang.INSUFFICIENT_INFO)
            } else if(doPlay || popupMode){
                play()
            }
        }
    }, 0)    
}
async function generateEpoch(){
    if(generating) return
    generating = true
    let result = jQuery('#main-container-right-items')
    setView(-1)
    let genreTags
    if(jQuery('#genre-tags-content .tag.disabled').length){
        genreTags = jQuery('#genre-tags-content .tag:not(.disabled)').map((i, e) => e.title).toArray()
        if(!genreTags.length){
            genreTags = undefined
        }
    }
    let title = (epoch ? epoch.from +'-'+ epoch.to : lang.ALL) + (genreTags ? ' - '+ genreTags.slice(0, 3) : '')
    let header = jQuery('#main-container-right-header'), headerMobile = jQuery('#main-container-right-header-mobile')
    let headers = header.add(headerMobile), headerTitle = '<span class="main-container-text">'+ title +'</span>'
    result.html('<li class="main-container-item main-container-item-center" align="center"><i class="fas fa-spinner fa-spin"></i> '+ lang.GENERATING +'</li>')
    header.html(headerTitle)
    headerMobile.html('<a href="#" id="mobile-back-icon" class="main-container-action main-container-action-about button-transparent" onclick="setView(0)"><i class="fas fa-chevron-left"></i></a>'+ headerTitle)
    setTimeout(async () => {
        let ret = await scanner.findFromEpoch(epoch, genreTags).catch(err => {
            console.error(err)
            result.html('<li class="main-container-item main-container-item-center main-container-item-red" align="center">'+ err +'</li>')
            if(popupMode) popupLoader.window.alert(String(err))
        })
        generating = false;
        if(ret){
            lastGenerate = ret
            lastGenerateExcludes = []
            let mcr = jQuery('#main-container-right')
            let result = jQuery('#main-container-right-items')
            mcr.hide()
            const els = scanner.config.get('list-size')
            let html = '', ls = Math.min(els, ret.files.length)
            if(ret.files.length){
                header.html('<span class="main-container-text">'+ title +'</span>')
                jQuery('<a href="#" class="main-container-action button-transparent" title="'+ lang.WATCH_ALL +'"><i class="fas fa-film"></i></a>').appendTo(headers).on('click', () => {
                    watch(currentGeneratedPlaylist())
                })
                jQuery('<a href="#" class="main-container-action button-transparent" title="'+ lang.SAVE +'"><i class="fas fa-save"></i></a>').appendTo(headers).on('click', () => {
                    let name = title.toLowerCase()
                    let ext = scanner.defaultPlaylistExtension()
                    name = 'Songtrip - '+ name
                    saveFileDialog(file => {
                        if(file) scanner.save(currentGeneratedPlaylist(), file)
                    }, name +'.'+ ext)
                })
                jQuery('<span class="main-container-action play-button button-secondary" title="'+ lang.PLAY +'"><i class="fas fa-play"></i><span> '+ lang.PLAY +'</span></span>').appendTo(headers).on('click', () => {
                    play()
                })
                if(!listGeneratedInfoLearned){
                    html += '<li class="main-container-item main-container-item-register" style="line-height: 150%; cursor: default; padding: var(--density-05x);"><div>'+ lang.LIST_GENERATED_INFO.format('<i class="fas fa-info-circle"></i>', '<i class="fas fa-times"></i>', lang.PLAY.toUpperCase())
                    html += '<span title="OK" style="display: block; margin: 0.5em 0;" class="button-main" onclick="listGeneratedInfoOK(this)"><i class="fas fa-check"></i> OK</span></div></li>'
                }
                for(let i=0;i<ls; i++){
                    html += renderResultItem(ret.files[i])
                }
            } else {
                html = '<li class="main-container-item main-container-item-center" align="center">'+ lang.EMPTY +'</li>'
            }
            result.html(html)
            mcr.show()
            result.scrollTop(0)
        }
    }, 0)    
}

function removeRightItem(e){
    let el = jQuery(e), result = jQuery('#main-container-right-items')
    let file = el.data('file'), currentFiles = currentGeneratedPlaylist()
    file = Buffer.from(file, 'base64').toString()
    lastGenerateExcludes.push(file)
    el.remove()
    for(let i=1;i<lastGenerate.files.length; i++){
        if(lastGenerateExcludes.includes(lastGenerate.files[i])) continue
        if(currentFiles.includes(lastGenerate.files[i])) continue
        let lastItem = result.find('.main-container-item:not(.main-container-item-register)').last()
        if(lastItem){
            let title = fileTitle(lastGenerate.files[i])
            let html = '<li class="main-container-item" '+
            ' data-file="'+ Buffer.from(lastGenerate.files[i]).toString('base64') +'" title="'+ title +'"><span class="main-container-text">'+ title +'</span>'+
            '<span class="main-container-action main-container-action-remove" title="'+ lang.REMOVE +'"><i class="fas fa-times"></i></span>' +                        
            '</li>'
            lastItem.after(html)
        }
        break
    }
}

function closeEditSong(){
    jQuery('html').removeClass('edit')
    destroyEditSongSelectors()
}

function editSong(e){
    if(typeof(e) == 'string'){
        e = jQuery('#main-container-left-items li[data-file="'+ e +'"] *:eq(0)').get(0)
    }
    let p = jQuery(e).parents('#main-container-left-items li')
    let file = Buffer.from(p.data('file'), 'base64').toString()
    let row = scanner.db.get(file)
    console.warn(p, file, row)
    if(!row) return
    let container = jQuery('#edit-song'), warn = container.find('#edit-song-warn')
    if(row.karma || !serverOnLine){
        warn.hide()
    } else {
        warn.html('<div style="display: block;"><i class="fas fa-exclamation-circle"></i> '+ lang.NO_MOOD_INFO +'</div>').show()
    }
    container.find('#edit-song-title').val(row.title || basename(file).replace(new RegExp('\\.[A-Za-z0-9]+$', 'i'), ''))
    container.find('#edit-song-artists').val(row.artist)
    setupEditSongSelectors(row.genre || [], row.language)
    container.find('#edit-song-year').val(row.year || '')
    container.find('#edit-song-file').text(file).off('click').on('click', () => {
        scanner.open(file, true)
    })
    container.find('button.edit-save').off('click').on('click', () => {
        let title = container.find('#edit-song-title').val()
        let artists = container.find('#edit-song-artists').val().replaceAll('/', '')
        let genre = container.find('#edit-song-genres').select2('data').map(r => r.id).join(', ')
        let language = container.find('#edit-song-language').select2('data').map(r => r.id).join(', ')
        let year = container.find('#edit-song-year').val()
        console.warn(genre, year, language)
        closeEditSong()
        let b = jQuery('<span class="main-container-action main-container-action-warn"><i class="fas fa-circle-notch fa-spin"></i></span>')
        let w = p.find('.main-container-action-warn')
        if(w.length){
            w.replaceWith(b)
        } else {
            p.append(b)
        }
        p.css({backgroundColor: '#c0efe6'})
        e.scrollIntoViewIfNeeded({ behavior: 'smooth', block: 'nearest', inline: 'start' })
        setTimeout(() => p.css({backgroundColor: 'transparent'}), 1000)
        scanner.update(file, {title, artists, genre, year, language}, (err, nrow) => {
            console.log('UPDATED', err, nrow)
            p.remove()
            nrow._title = rowTitle(nrow, file)
            nrow.file = file
            let currentArtists = getArtistsElementsAsObject()
            let position = getInsertPosition(nrow.artist, title, currentArtists)
            renderLibraryItemCurrentArtist =  position.newArtist ? 'Songtrip' : nrow.artist // before renderLibraryItem()
            let item = jQuery(renderLibraryItem(nrow))
            if(position.before){
                jQuery(position.element).before(item)
            } else {
                jQuery(position.element).after(item)
            }
            if(!getArtistSongsElements(row.artist, currentArtists).length){
                jQuery(currentArtists[row.artist]).remove()
            }
            item.css({backgroundColor: 'var(--button-main-shadow)'})
            item.get(0).scrollIntoViewIfNeeded({ behavior: 'smooth', block: 'nearest', inline: 'start' })
            generate()
            setTimeout(() => item.css({backgroundColor: 'transparent'}), 1000)
            if(err) setTimeout(() => alert(err), 0) // allow rendering first
        })
    })
    e.scrollIntoViewIfNeeded({ behavior: 'smooth', block: 'nearest', inline: 'start' })
    jQuery('html').addClass('edit')
}

function getInsertPosition(artist, title, currentArtists){
    if(!currentArtists) {
        currentArtists = getArtistsElementsAsObject()
    }
    if(Object.keys(currentArtists).includes(artist)){
        let songs = getArtistSongsElements(artist, currentArtists)
        if(songs.length){
            let nextElement
            songs.some(s => {
                if(s.innerText.trim().toLowerCase() > title.toLowerCase()) {
                    nextElement = s
                    return true
                }
            })
            if(nextElement){
                return {insert: 'before', newArtist: false, element: nextElement}
            } else {
                return {insert: 'before', newArtist: false, element: songs[0]}
            }
        } else {
            return {insert: 'after', newArtist: false, element: currentArtists[artist]}
        }
    } else {
        let nextElement
        let artistlc = artist.toLowerCase()
        Object.keys(currentArtists).some(a => {
            if(a.toLowerCase() > artistlc){
                nextElement = currentArtists[a]
                return true
            }
        })
        if(nextElement){
            return {insert: 'before', newArtist: true, element: nextElement}
        } else {
            return {insert: 'before', newArtist: true, element: currentArtists[Object.keys(currentArtists)[0]]}
        }
    }
}

function getArtistsElementsAsObject(){
    const currentArtists = {}
    jQuery('.main-container-item-artist').each((i, item) => {
        currentArtists[item.innerText.trim()] = item
    })
    return currentArtists
}

function getArtistSongsElements(artist, currentArtists){
    if(!currentArtists) {
        currentArtists = getArtistsElementsAsObject()
    }
    let current = currentArtists[artist], songs = []
    while(current.nextElementSibling && current.nextElementSibling.className.indexOf('main-container-item-artist') == -1){
        current = current.nextElementSibling
        songs.push(current)
    }
    return songs
}

var listGeneratedInfoLearned
function listGeneratedInfoOK(element){
    jQuery(element).parent().remove()
    listGeneratedInfoLearned = true
    let n = scanner.config.get('list-generated-learned')
    if(typeof(n) != 'number'){
        n = 0
    }
    n++
    scanner.config.set('list-generated-learned', n)
}

var renderingLibrary, renderLibraryItemCurrentArtist
function renderLibraryItem(row, bfile){
    if(!bfile){
        bfile = Buffer.from(row.file).toString('base64')
    }
    let c = '', html = '', flags = '<span class="main-container-actions"><span>'
    if(!row.mood_happy){
        flags += '<span class="main-container-action main-container-action-warn main-container-action-edit" title="'+ lang.NO_MOOD_INFO +'"><i class="fas fa-exclamation-circle"></i></span>'
    }    
    flags += '</span></span>'
    if(!row._title){
        row._title = rowTitle(row, row.file)
    }
    if(row.artist != renderLibraryItemCurrentArtist){
        c += 'first-of-artist '
        renderLibraryItemCurrentArtist = row.artist
        html += '<li class="main-container-item main-container-item-artist" title="'+ row.artist +'">'+
            '<span title="'+ row._title +'" class="main-container-text"><span class="main-container-text-ellipsable"><strong>'+ row.artist.charAt(0) +'</strong>'+ row.artist.substr(1) +'</span></span>'
            '</li>'
    }
    let genres = row.genre ? row.genre.join(',') : ''
    html += '<li class="main-container-item '+ c +'" title="'+ row._title +'" data-file="'+ bfile +'" data-genres="'+ genres +'" >'+
        '<span title="'+ row._title +'" class="main-container-text"><span class="main-container-text-ellipsable"><span class="main-container-item-play-icon"><i class="fas fa-play"></i> </span>'
    html += row.title
    if(row.artist){
        html += '<span class="main-container-text-artist"> &middot; '+ row.artist +'</span>'
    }
    html += '</span>'+ flags +'</span></li>'
    return html
}

function renderMapDot(row, bfile){
    if(row.karma){
        if(!row._title){        
            row._title = rowTitle(row, row.file)
        }
        if(!bfile){
            bfile = Buffer.from(row.file).toString('base64')
        }
        let firstLetter = row._title.match(new RegExp('[a-z]', 'i'))
        let genres = row.genre ? row.genre.join(',') : ''
        return '<div class="map-dot" '+
            'title="'+ row._title +'" data-file="'+ bfile +'" data-genres="'+ genres +'" '+
            'style="top: '+ (100 - row.karma[1]) +'%; left: '+ row.karma[0] +'%" '+
            '>'+ firstLetter +'</div>'        
    }
    return ''
}

var mcli = {
    index: document.getElementById('main-container-left-items-index'),
    container: document.getElementById('main-container-left-items'),
    magnifier: document.getElementById('main-container-left-items-index-magnifier'),
    letters: []
}

function sortLibrary(data){
    data = data.map(row => {
        row.iartist = row.artist.toUpperCase()
        return row
    })
    return data.sortByProp('title').sortByProp('iartist')
}

function renderLibrary(){
    return new Promise((resolve, reject) => {
        renderingLibrary = true
        let container = jQuery('#main-container-left-items')
        container.html('<li class="main-container-item main-container-item-center" align="center"><i class="fas fa-spinner fa-spin"></i> Lendo biblioteca...</li>')
        scanner.db.ready().then(() => {
            let files = Object.keys(scanner.db.data)
            if(files.length){
                jQuery('#main-container-left-items').html('')
                let html = '', mapHtml = '', data = sortLibrary(Object.keys(scanner.db.data).map(file => {
                    const row = scanner.db.data[file]
                    row.file = file
                    return row
                }))
                let letters = []
                data.forEach(row => {
                    let bfile = Buffer.from(row.file).toString('base64'), letter = row.artist.charAt(0).toUpperCase()
                    html += renderLibraryItem(row, bfile)
                    mapHtml += renderMapDot(row, bfile)
                    if(letter && !letters.includes(letter)){
                        letters.push(letter)
                    }
                })
                mcli.letters = letters
                document.documentElement.style.setProperty('--main-container-left-items-index-length', letters.length);
                html += '<div class="main-container-left-items-letter"></div>'
                container.html(html)
                jQuery('#map-inner > div').html(mapHtml)
                jQuery('#main-container-left-items-index').html(letters.map(c => '<span class="main-container-left-items-index-letter">'+ c +'</span>').join(''))
                let genreTagsContent = jQuery('#genre-tags-content')
                genreTagsContent.html('')
                scanner.getAllGenreTags().forEach(tag => {
                    genreTagsContent.append('<span class="tag" title="'+ tag.g +'">'+ tag.g +' ('+ tag.count +')</span>')
                })
                resolve()         
            } else {
                container.html('<li class="main-container-item main-container-item-center">'+ lang.EMPTY +'</li>')
                enterLibrarySetup()
                resolve()
            }
        }).catch(err => {
            console.error(err)
            container.html('<li class="main-container-item main-container-item-center main-container-item-red" align="center">'+ err +'</li>')           
            reject(err)
        }).finally(() => {
            setTimeout(() => {
                renderingLibrary = false
                processLettersArea()
            }, 1000)
        })
    })
}

function genreTagsSelectAll(select){
    if(select){
        jQuery('#genre-tags-content .tag.disabled').removeClass('disabled')
    } else {
        jQuery('#genre-tags-content .tag:not(.disabled)').addClass('disabled')
    }
    delayedGenerateEpoch()
}

var activeView
function setView(n){
    if(n == 0){
        jQuery('html').removeClass('edit library-setup')
    }
    if(n != activeView){
        if(n == -1 && document.documentElement.className.indexOf('mobile') == -1){
            return
        }
        activeView = n;
        [-1, 0, 1, 2, 3, 4, 5].map(i => 'view-'+ i).map(c => jQuery('html').removeClass(c))
        jQuery('html').addClass('view-'+ n)
        jQuery('#main-container-left > *:not(#main-container-left-header):not(#main-container-left-header-mobile)').each((i, e) => {
            if(i == n){
                e.style.display = (i == 0) ? 'block' : 'flex'
            } else {
                e.style.display = 'none'
            }
        })
        document.getElementById('main-container-left-items-index').style.display = n == 0 ? 'flex' : 'none'
        if(n == -1){

        } else {
            jQuery('#main-container-left-header > a').each((i, e) => {
                if(i == n){
                    jQuery(e).removeClass('inactive')
                } else {
                    jQuery(e).addClass('inactive')
                }
            })
            if(n == 1){
                jQuery('#map').addClass('wizard')
                mapWizardStep(0)
            }
        }
    }
}

var similarityWeights

function saveSimilarityOptions(){
    if(similarityWeights){
        scanner.similarityWeights(similarityWeights)
    }
}

function resetSimilarityOptions(){
    similarityWeights = Object.assign({}, scanner.config.defaults['similarity-weights'])
    scanner.similarityWeights(similarityWeights)
}

function toggleAlgorithmSlider(id){
    const e = document.getElementById(id), att = id.split('-').pop()
    const d = scanner.config.defaults['similarity-weights'][att]
    const c = parseFloat(e.value)
    if(c == 0){
        if(d > 0){
            e.value = d
        } else {
            e.value = 1
        }
    } else if(c == 1) {
        e.value = 0
    } else {
        e.value = 1
    }
    e.dispatchEvent(new Event('input'))
}

function updateSimilarityOptions(){
    let essBlock = `<div class="essentia-sliders"><div><strong>Essentia&trade;</strong></div>`, sliders = document.querySelector('div#sliders')
    if(!similarityWeights){
        similarityWeights = scanner.similarityWeights()
    }
    sliders.innerHTML = `
    <div style="margin-top: calc(var(--density) / 3.5);">
        <label for="list-size" data-language="LIST_SIZE" title="Tamanho da lista">Tamanho da lista</label>
        <input type="number" id="list-size" min="5" value="5" max="9999" maxlength="4">
    </div>`
    Object.keys(similarityWeights).forEach(k => {
        const ess = k.match(new RegExp('(mood|genre_|rhythm)', 'i'))
        const lk = ess ? k : (lang[k.toUpperCase()] || ucWords(k.replaceAll('_', ' ')))
        const block = `
    <div class="slidecontainer">
        <label for="slider-${k}"><a href="javascript:;" onclick="toggleAlgorithmSlider('slider-${k}')">${lk}</a></label>
        <input type="range" min="0" max="1" step="0.05" value="${similarityWeights[k]}" class="slider" id="slider-${k}">
    </div>`
        if(ess){
            essBlock += block
        } else {
            sliders.innerHTML += block
        }
    })
    essBlock += '</div>'
    sliders.innerHTML += essBlock
    Object.keys(similarityWeights).forEach(k => {
        let slider = sliders.querySelector('#slider-'+ k)
        slider.addEventListener('input', () => {
            similarityWeights[k] = parseFloat(slider.value)
            console.log('INPUT', k, slider.value, similarityWeights)
        })
    })
    let size = scanner.config.get('list-size')
    let sizeOpt = jQuery('#list-size')
    sizeOpt.val(size)
    sizeOpt.on('change', () => {
        let size = parseInt(sizeOpt.val())
        if(size < 5){
            size = 5
            sizeOpt.val(5)
        }
        scanner.config.set('list-size', size)        
    })
}

let rightItems = jQuery('#main-container-right-items')
rightItems.on('mouseenter', '.main-container-item', e => {
    let target = jQuery(e.currentTarget)
    if(!target.hasClass('main-container-item-center') && !target.hasClass('main-container-item-warn') && !target.hasClass('main-container-item-register')){
        target = target.find('.main-container-action-remove')
        let action = jQuery('<span class="main-container-action main-container-action-info" title="'+ lang.ABOUT +'"><i class="fas fa-question"></i></span>')
        action.css('display', 'inline-flex')
        target.before(action)
        let edit = jQuery('<span class="main-container-action main-container-action-edit main-container-action-edit" title="'+ lang.EDIT +'"><i class="fas fa-edit"></i></span>')
        edit.css('display', 'inline-flex')
        target.before(edit)
    }
})
rightItems.on('mouseleave', '.main-container-item', e => {
    jQuery(e.currentTarget).find('.main-container-action:not(.main-container-action-remove)').remove()
})
rightItems.on('click', '.main-container-action-remove', e => {
    removeRightItem(e.currentTarget.parentNode)
    e.preventDefault()
    e.stopPropagation()
})
rightItems.on('click', '.main-container-action-edit', e => {
    let el = jQuery(e.currentTarget).parents('.main-container-item')
    editSong(e.currentTarget)
    e.preventDefault()
    e.stopPropagation()
})
rightItems.on('click', '.main-container-action-info', e => {
    let el = jQuery(e.currentTarget).parent()
    let file = el.data('file')
    file = Buffer.from(file, 'base64').toString()
    alert(lastGenerate.log[file])
    e.preventDefault()
    e.stopPropagation()
})

let leftitems = jQuery('#main-container-left-items')
leftitems.on('mouseenter', '.main-container-item', e => {
    let target = jQuery(e.currentTarget)
    if(!target.hasClass('main-container-item-center')){
        let actions = ''
        actions += '<span class="main-container-action main-container-action-watch" title="'+ lang.WATCH +'"><i class="fas fa-film"></i></span>'
        actions += '<span class="main-container-action main-container-action-play" title="'+ lang.PLAY +'"><i class="fas fa-play"></i></span>'
        let action = jQuery(actions)
        action.css('display', 'inline-flex')
        let prevAction = target.find('.main-container-action:eq(0)')
        if(prevAction.length){
            prevAction.before(action)
        } else {
            target = target.find('.main-container-actions > span')
            target.append(action)
            let edit = jQuery('<span class="main-container-action main-container-action-edit" onclick="editSong(this)" title="'+ lang.EDIT +'"><i class="fas fa-edit"></i></span>')
            edit.css('display', 'inline-flex')
            target.append(edit)
        }
    }
})
leftitems.on('mouseleave', '.main-container-item', e => {
    jQuery(e.currentTarget).find('.main-container-action:not(.main-container-action-warn)').remove()
})
leftitems.on('click', '.main-container-text', e => {
    console.log('EVENT', e)
    let el = jQuery(e.currentTarget).parents('.main-container-item')
    let title = el.attr('title'), file = el.data('file')
    if(!file) return
    file = Buffer.from(file, 'base64').toString()
    generate(file, title)
})                    
leftitems.on('mouseenter', '.main-container-actions', e => {
    jQuery(e.currentTarget).parents('.main-container-item').attr('draggable', false)
    jQuery('#main-container-left-items').sortable('disable')
})                      
leftitems.on('mouseleave', '.main-container-actions', e => {
    jQuery(e.currentTarget).parents('.main-container-item').attr('draggable', true)
    jQuery('#main-container-left-items').sortable('enable')
})                   
leftitems.on('click', '.main-container-action-watch', e => {
    console.log('wEVENT', e)
    let el = jQuery(e.currentTarget).parents('.main-container-item')
    let file = el.data('file')
    file = Buffer.from(file, 'base64').toString()
    watch([file])
    e.preventDefault()
    e.stopPropagation()
})                  
leftitems.on('click', '.main-container-action-edit', e => {
    let el = jQuery(e.currentTarget).parents('.main-container-item')
    editSong(e.currentTarget)
    e.preventDefault()
    e.stopPropagation()
})               
leftitems.on('click', '.main-container-action-play', e => {
    let el = jQuery(e.currentTarget).parents('.main-container-item')
    let title = el.attr('title'), file = el.data('file')
    if(!file) return
    file = Buffer.from(file, 'base64').toString()
    generate(file, title, true)
    e.preventDefault()
    e.stopPropagation()
})

lettersAreas = {}
function processLettersArea(){
    let lastLetter
    lettersAreas = {}
    Array.from(document.querySelectorAll('.main-container-item-artist')).forEach(e => {
        let letter = String(e.innerText)
        if(letter.length){
            letter = letter[0].toUpperCase()
            if(typeof(lettersAreas[letter]) == 'undefined'){
                lettersAreas[letter] = {start: -1, end: -1}
            }
            if(lettersAreas[letter].start == -1){
                lettersAreas[letter].end = lettersAreas[letter].start = e.offsetTop
                if(lastLetter){
                    lettersAreas[lastLetter].end = e.offsetTop
                }
                lastLetter = letter
            } else {
                lettersAreas[letter].end = e.offsetTop
            }
        }
    })
}
window.addEventListener('resize', processLettersArea)

function updateLetterMagnifier(letter, clientY){    
    if(mcli.magnifier.innerHTML != letter){
        mcli.magnifier.innerHTML = letter
    }
    let h = document.body.offsetHeight, clientYMax = h - mcli.magnifier.offsetHeight
    if(clientY < 0) clientY = 0
    if(clientY > clientYMax) clientY = clientYMax
    mcli.magnifier.style.top = clientY +'px'
}

const mmv = e => {
    if(mcli.active){
        let la = mcli.index.offsetHeight / mcli.letters.length
        let ps = (e.clientY - mcli.index.offsetTop) / la
        let pt = ps - parseInt(ps)
        let field = lettersAreas[mcli.letters[parseInt(ps)]]
        if(field){
            let ad = (field.end - field.start) * pt
            mcli.container.scrollTop = field.start + ad
            updateLetterMagnifier(mcli.letters[parseInt(ps)], e.clientY)
        }
    }
}

jQuery(mcli.index).on('mousedown', e => {
    mcli.active = true
    mcli.magnifier.style.opacity = 1
    if(mcli.magnifierHideTimer){
        clearTimeout(mcli.magnifierHideTimer)
    }
    mmv(e)
}).on('mousemove', mmv)

jQuery(document).on('mouseup', () => {
    mcli.active = false
    mcli.magnifier.style.opacity = 0
})

function mainContainerLeftItemsScroll(e){
    if(mcli.active || renderingLibrary) return
    mcli.magnifier.style.opacity = 1
    if(mcli.magnifierHideTimer){
        clearTimeout(mcli.magnifierHideTimer)
    }       
    var ttop = mcli.container.scrollTop + mcli.container.offsetTop
    var clientY = (mcli.container.scrollTop / mcli.container.scrollHeight) * mcli.index.offsetHeight
    clientY += mcli.container.offsetTop
    Array.from(mcli.container.querySelectorAll('li.main-container-item-artist')).some(item => {
        if(item.offsetTop >= ttop && item.innerText.length){
            const letter = item.innerText[0]
            updateLetterMagnifier(letter, clientY)
            mcli.magnifierHideTimer = setTimeout(() => {
                mcli.magnifier.style.opacity = 0
            }, 2000)
            return true
        }
    })
}
mcli.container.addEventListener('scroll', mainContainerLeftItemsScroll)

const gtc = jQuery('#genre-tags-content')
gtc.on('click', '.tag', event => {
    let el = jQuery(event.target)
    let title = el.attr('title')
    let method = el.hasClass('disabled') ? 'removeClass' : 'addClass'
    el[method]('disabled')
    gtc.find('.tag[title*="'+ title +'"]')[method]('disabled')
    delayedGenerateEpoch()
})

jQuery('#map').on('click', event => {
    console.warn('mapclick', event)
    let file = event.target.getAttribute('data-file')
    if(file) {
        let title = event.target.title
        if(file){
            file = Buffer.from(file, 'base64').toString()
            generate(file, title)
        }
    } else if(event.target.id && ['map-inner', 'map-inner-dots'].includes(event.target.id)){
        let target = document.querySelector('#map-inner')
        let width = target.offsetWidth, height = target.offsetHeight
        let x = Math.min(100, event.offsetX / (width / 100))
        let y = 100 - Math.min(100, event.offsetY / (height / 100))
        generate(x, y)
    }
}).on('dblclick', () => jQuery('#map').addClass('wizard'))

jQuery('body').on('keypress', event => {
    if(event.key.length == 1){
        if(event.target.tagName && ['input', 'textarea'].includes(event.target.tagName.toLowerCase())) return
        jQuery('#main-container-left-items .main-container-item[title^="'+ event.key.toUpperCase() +'"]:eq(0)').get(0).scrollIntoView()
    }
})

var mainContainerFilterTimer = 0
function filterItems(val){
    if(val){
        let vals = val.toLowerCase().split(' ').filter(s => s)
        jQuery('#main-container-left-items .main-container-item, .map-dot').each((i, e) => {
            let html = e.title.toLowerCase() +' '+ e.getAttribute('data-genres'), matched = vals.every(v => html.indexOf(v) != -1)
            if(matched){
                e.style.display = 'flex'
            } else {
                e.style.display = 'none'
            }
        })
    } else {
        jQuery('#main-container-left-items .main-container-item, .map-dot').css('display', 'flex')
    }
    jQuery('#main-container-left-items').scrollTop(0)
}

function filter(e){
    if(!e) e = document.querySelector('.main-container-filter input')
    clearTimeout(mainContainerFilterTimer)
    let el = jQuery(e), val = el.val().trim()
    mainContainerFilterTimer = setTimeout(() => filterItems(val), 400)
    if(val){
        let filter = el.parent().find('.fa-search')
        if(filter && filter.length){
            filter.replaceWith('<i class="fas fa-times-circle"></i>')
        }
    } else {
        let clear = el.parent().find('.fa-times-circle')
        if(clear && clear.length){
            clear.replaceWith('<i class="fas fa-search"></i>')
        }
    }
    if(activeView > 1) setView(0)
}

function setupOptions(){
    ['relative-paths', 'backslashes'].forEach(n => {
        let opt = jQuery('#'+ n)
        switch(scanner.config.get(n)){
            case true:
                opt.val('yes')
                break
            case false:
                opt.val('no')
                break
            default:
                opt.val('auto')
        }
        opt.on('change', () => {
            let value = opt.val()
            switch(value){
                case 'yes':
                    value = true
                    break
                case 'no':
                    value = false
                    break
                default:
                    value = 'auto'
            }
            scanner.config.set(n, value)
        })
    })
    const chooser = jQuery('#choose-player')
    chooser.on('change', () => {
        scanner.config.set('player', prepareSlashes(chooser.val(), true))
    })
    chooser.val(scanner.config.get('player'))
}

var rangeSliderCreated, epochRange = {min: 1860, max: (new Date()).getFullYear()}
function setupEpochView(){
    if(typeof(scanner) != 'undefined' && scanner){
        let r = scanner.getEpochRange()
        if(r && r.max){
            epochRange = r
        }
    }
    let slider = document.getElementById('epoch-slider-input')
    if(rangeSliderCreated){
        slider.noUiSlider.updateOptions({
            range: {
                'min': epochRange.min,
                'max': epochRange.max
            }
        });
    } else {
        noUiSlider.create(slider, {
            start: [epochRange.min, epochRange.max],
            connect: true,
            step: 1,
            tooltips: true,
            range: {
                'min': epochRange.min,
                'max': epochRange.max
            },
            format: {
                // 'to' the formatted value. Receives a number.
                to: function (value) {
                    return parseInt(value)
                },
                // 'from' the formatted value.
                // Receives a string, should return a number.
                from: function (value) {
                    return parseInt(value)
                }
            }
        })
        setTimeout(() => {
            slider.noUiSlider.on('update', values => {
                if(!document.getElementById('epoch-slider-input').offsetHeight) return // not visible
                if(values[0] == epochRange.min && values[1] == epochRange.max){
                    epoch = null
                } else {
                    epoch = {from: values[0], to: values[1]}
                }
                console.log("SLIDER VAL", epoch, values)
                delayedGenerateEpoch()
            })
        }, 2000)
        rangeSliderCreated = true
    }
}

function setupMobileSearch(){
    setView(0)
    jQuery('.main-container-filter input').get(0).focus()
}

function mapAdvanced(){
    jQuery('#map').removeClass('wizard')
}

var mapWizardStepValues = [5, 5]
function mapWizardStep(step){
    if(step > 2) step = 0
    var tpl, tpl0 = `<div><div style="margin-bottom: var(--density);">
${lang.SET_HAPPINESS}
</div>
<slider></slider>
<button class="button-main">${lang.NEXT}</button>
</div>`
    var tpl1 = `<div><div style="margin-bottom: var(--density);">
${lang.SET_ENERGY}
</div>
<slider></slider>
<button class="button-main">${lang.CONFIRM}</button>
</div>`
    var tpl2 = `<div>
${lang.LIST_GENERATED}
<div style="flow-direction: row;">
<button class="play-button button-secondary" onclick="play()" title="${lang.PLAY}"><i class="fas fa-play"></i> ${lang.PLAY}</button>&nbsp;<button class="button-main">${lang.REDO}</button>
</div></div>`
    switch(step){
        case 0:
            tpl = tpl0
            break
        case 1:
            tpl = tpl1
            break
        case 2:
            tpl = tpl2
            console.warn('VALUES', mapWizardStepValues)
            let x = mapWizardStepValues[0] * 10
            let y = mapWizardStepValues[1] * 10
            console.warn('VALUES', x, y)
            generate(x, y)
    }
    let advIcon = 'fas fa-plus-circle', adv = '<div style="margin-top: 1rem;"><a href="javascript:mapAdvanced();void(0)" title="'+ lang.ADVANCED_MODE +'" style="color: black;position: relative;top: -1px;text-decoration: none;"><i class="'+ advIcon +'" style="font-size: 83%;"></i> '+ lang.ADVANCED_MODE +'</a></div>'
    tpl = tpl.substr(0, tpl.length - 6) + adv + tpl.substr(-6)
    jQuery('#map-wizard').html(tpl)
    jQuery('#map-wizard').find('button').last().on('click', () => mapWizardStep(step + 1))
    let slider = document.querySelector('#map-wizard slider')
    if(slider) {
        let range = {min: 0, max: 10}
        noUiSlider.create(slider, {
            start: mapWizardStepValues[step],
            connect: [true, false],
            step: 1,
            tooltips: true,
            range: {
                'min': range.min,
                'max': range.max
            },
            format: {
                // 'to' the formatted value. Receives a number.
                to: value => {
                    return parseInt(value)
                },
                // 'from' the formatted value.
                // Receives a string, should return a number.
                from: value => {
                    return parseInt(value)
                }
            }
        })
        slider.noUiSlider.on('update', values => {
            mapWizardStepValues[step] = values[0]
        })
        //jQuery(slider).css('display', 'flex') // set as flex only after build the slider
    }
}

jQuery('.main-container-filter input').on('input', e => filter(e.currentTarget))

jQuery('.main-container-filter').on('click', 'i.fa-times-circle', e => {
    jQuery('.main-container-filter input').trigger('focus').val('')
    filter()
})

var containerOffsetX, adjustment, $body = jQuery('body')
jQuery('#main-container-left-items').sortable({
    group: 'drag-drop',
    drop: false,
    handle: '.main-container-text',
    onDragStart: function (item, container, _super) {
        containerOffsetX = document.getElementById('main-container-right-items').getBoundingClientRect().x
        var offset = item.offset(), pointer = container.rootGroup.pointer   
        adjustment = {
            left: pointer.left - offset.left,
            top: pointer.top - offset.top
        }
        if(container.el.attr('id') == 'main-container-left-items'){
            item.clone().insertAfter(item).trigger('mouseleave')
        }
        _super(item, container)
    },
    onDrag: function (item, position) {
        if(position.left >= containerOffsetX){
            if(!$body.hasClass('can-drop')){
                $body.addClass('can-drop')
            }
        } else {
            if($body.hasClass('can-drop')){
                $body.removeClass('can-drop')
            }
        }
        item.css({
            left: position.left - adjustment.left,
            top: position.top - adjustment.top
        })
    },
    onDrop: function  (item, container, _super) {
        _super(item, container)
        let allow = $body.hasClass('can-drop') && !item.hasClass('main-container-item-artist'), trigger = () => {            
            let el = item
            let title = el.attr('title'), file = el.data('file')
            if(!file) return
            file = Buffer.from(file, 'base64').toString()
            generate(file, title)
        }
        console.warn('ONDROP', item, allow)
        if(allow){
            if(container.el.find('.main-container-item-center').length){
                allow = false
                trigger()
            }
        } else {
            trigger()
        }
        if(!allow){
            item.remove()
        }
    }
})

jQuery('#main-container-right-items').sortable({
    group: 'drag-drop',
    handle: '.main-container-text'
})

function setupLanguageSelector(availableLanguages, userLanguage){
    console.warn('lang', availableLanguages, userLanguage)
    let select = jQuery("#lang-select")
    availableLanguages.forEach(l => {
        let n = langs.where(1, l)
        n = n ? n.local : l
        select.append('<option value="'+ l +'" '+ (l == userLanguage ? 'selected' : '') +'>'+ n +'</option>')
    })
    select.on('change', () => {
        scanner.config.set('language', select.val())
        restart()
    })
}

function setupPlaylistFmtSelector(availablePlaylistFormats, currentPlaylistFormat){
    const parseFormatName = name => {
        let parts = name.split('-')
        if(parts.length > 1){
            switch(parts[1]){
                case 'latin1':
                    parts[1] = '(Microsoft)'
                    break
                case 'utf8':
                    parts[1] = ''
                    break
            }
        }
        parts[0] = parts[0].toUpperCase()
        return parts.join(' ')
    }
    console.warn('playlist format', availablePlaylistFormats, currentPlaylistFormat)
    let select = jQuery("#playlist-fmt-select")
    select.append('<option value="auto" '+ (currentPlaylistFormat == 'auto' ? 'selected' : '') +'>Auto</option>')
    availablePlaylistFormats.forEach(f => {
        select.append('<option value="'+ f +'" '+ (f == currentPlaylistFormat ? 'selected' : '') +'>'+ parseFormatName(f) +'</option>')
    })
    select.on('change', () => {
        scanner.config.set('playlist-format', select.val())
    })
}

function restart(){
    console.log('restartApp') 
    process.on('exit', () => {
        require('child_process').spawn(process.execPath, nw.App.argv, { 
            shell: true,
            detached: true,
            stdio: 'inherit'
        }).unref()
    })
    process.nextTick(() => process.exit())
}

function getAllLanguages(){
    const languages = {}
    langs.all().forEach(r => {
        languages[r[3]] = r.name
    })
    return languages
}

function insertSelect2SearchIcon(){
    jQuery('.select2-search--dropdown').each((i, e) => {
        if(!e.querySelector('.select2-search-icon')){
            let h = e.querySelector('input').offsetHeight, fs = h * 0.6, t = h * 0.2, r = h * 0.4
            jQuery('<span class="select2-search-icon" style="font-size: '+ fs +'px;position: absolute;top: '+ t +'px;right: '+ r +'px;transform: rotateY(180deg);"><i class="fas fa-search"></i></span>').prependTo(e)
        }
    })
}

function setupEditSongSelectors(genres, language){
    const languageSelect = jQuery('#edit-song-language')
    languageSelect.append('<option value=""></option>')
    const languages = getAllLanguages()
    Object.keys(languages).forEach(loc => {
        const opt = document.createElement('option')
        opt.value = loc
        opt.innerText = languages[loc]
        if(opt.value == language) opt.selected = true
        languageSelect.append(opt)
    })
    languageSelect.select2({
        placeholder: lang.LANGUAGE,
        allowClear: true
    })
    languageSelect.on('select2:open', () => {
        insertSelect2SearchIcon()
    })
    let tags = scanner.getAllGenreTags(), genreSelect = jQuery('#edit-song-genres')
    genreSelect.append('<option value=""></option>')
    tags.forEach(row => {
        const opt = document.createElement('option')
        opt.value = row.g
        opt.innerText = row.g
        if(genres.includes(opt.value)) opt.selected = true
        genreSelect.append(opt)
    })
    genreSelect.select2({
        tags: true,
        placeholder: lang.GENRES,
        allowClear: true
    })
}

function destroyEditSongSelectors(){
    const languageSelect = jQuery('#edit-song-language'), genreSelect = jQuery('#edit-song-genres')
    languageSelect.select2('destroy').find('option').remove()
    genreSelect.select2('destroy').find('option').remove()
}

function density(value){
    var r = document.querySelector(':root')
    if(typeof(value) == 'number'){
        document.querySelector('#density-input').value = value
    } else {
        value = document.querySelector('#density-input').value  
        scanner.config.set('density', value)
    }
    r.style.setProperty('--density', value +'rem')  
}
    
function parseMomentLocale(content){
    let startPos = content.indexOf('moment.defineLocale('), endPos = content.lastIndexOf('return ')
    if(startPos != -1 && endPos != -1){
        content = content.substr(startPos, endPos - startPos)
    }
    return content
}

function importMomentLocale(locale, cb){
    importMomentLocaleCallback = cb
    jQuery.ajax({
        url: 'node_modules/moment/locale/' + locale + '.js',
        dataType: 'text',
        cache: true
    }).done(content => {
        let txt = parseMomentLocale(content)
        jQuery('<script>').attr('type', 'text/javascript').text('try{ '+ txt + '} catch(e) { console.error(e) };importMomentLocaleCallback()').appendTo('head')
    }).fail((jqXHR, textStatus) => {
        console.error( "Request failed: " + textStatus )
    })
}

var appLoaded = []
function appLoad(fn){
    if(Array.isArray(appLoaded)){
        appLoaded.push(fn)
    } else {
        fn()
    }
}

appLoad(() => {
    if(popupMode) return
    jQuery('#about-version').html('Songtrip v'+ nw.App.manifest.version)
})

appLoad(() => {
    if(popupMode) return
    if(lang.locale && !moment.locales().includes(lang.locale)){
        importMomentLocale(lang.locale, () => {
            moment.locale(lang.locale)
        })
    }
})

appLoad(() => {
    if(popupMode) return
    setTimeout(async () => {
        let hasUpdates = await scanner.checkUpdates()
        if(hasUpdates){
            if(confirm(lang.NEW_VERSION_AVAILABLE)){
                scanner.open('https://songtrip.in')
            }
        }
    }, 5000)
})

appLoad(() => {
    const bs = jQuery('.by-selector')
    bs.on('mouseenter', () => {
        bs.addClass('active')
    }).
    on('mouseleave', () => {
        bs.removeClass('active')
    }).find('a').
    on('click', event => {
        const e = jQuery(event.currentTarget)
        setView(e.data('target-view'))
        e.parent().prepend(e)
        bs.removeClass('active')
    })
})

appLoad(() => {
    if(popupMode) return
    window.ondragover = e => {
        e.preventDefault()
        return false
    }
    window.ondrop = e => {
        e.preventDefault()
        return false
    }
    let holder = jQuery(document.body)
    holder.on('drop', e => {
        isOver = false
        console.log('ondrop', e)
        holder.removeClass('dragging-over')
        e.preventDefault()
        e.stopPropagation()
        e = e.originalEvent
        let enterSetup = true, fs = require('fs')
        for (let i = 0; i < e.dataTransfer.files.length; ++i) {
            let file = e.dataTransfer.files[i].path
            let stats = fs.statSync(file)
            if(stats){
                if(stats.isDirectory()){
                    addLibraryFolder(file)
                } else {
                    if(!addLibraryFolder(dirname(file))){
                        file = fixpath(file)
                        if(typeof(scanner.db.data[file]) != 'undefined'){
                            generate(file, file.split('/').pop())
                            enterSetup = false
                            break
                        }
                    }
                }
            }
        }
        if(enterSetup){
            enterLibrarySetup()
        }
        return false
    })
})

var isMobile, win = jQuery(window)
win.on('resize load', () => {
    let ratio = window.innerWidth / window.innerHeight, mobile = ratio < 1.33
    if(mobile != isMobile){
        isMobile = mobile
        if(isMobile){
            jQuery('html').removeClass('desktop').addClass('mobile')
        } else {
            jQuery('html').removeClass('mobile').addClass('desktop')
            if(activeView == -1) setView(0)
        }
    }
    setupEpochView()
})

window.addEventListener('load', async function (){
    const win = nw.Window.get()
    win.on('close', () => {
        win.close(true)
        process.exit()
    })

    window.osd = new OSD('#osd-root')

    const availableLanguages = require('fs').readdirSync('lang').filter(f => f.indexOf('.json') != -1).map(f => f.replaceAll('.json', ''))
    window.scanner = new Scanner({paths})
    scanner.on('error', notify)
    setTheme(scanner.config.get('theme') || '#00090A-#3C4148')
    let userLanguage = scanner.config.get('language') || navigator.languages.map(e => {
        if(availableLanguages.includes(e)){
            return e
        }
        e = e.substr(0, 2)
        if(availableLanguages.includes(e)){
            return e
        }        
    }).filter(l => l).shift()
    console.warn('lang', availableLanguages, userLanguage)
    scanner.opts.lang = window.lang = await loadLanguage(userLanguage, 'lang').catch(e => alert(String(e)))
    loadTheme()
    await scanner.db.ready()
    scanner.server.on('online', () => {
        serverOnLine = true
        updateInternetConnState()
    })
    scanner.server.on('offline', () => {
        serverOnLine = false
        updateInternetConnState()
    })
    jQuery(window).on('online', updateInternetConnState).on('offline', updateInternetConnState)
    var internetConnStateOsdID = 'network-state', updateInternetConnState = () => {
        scanner.setInternetConnState(navigator.onLine)
        if(navigator.onLine){
            if(serverOnLine){
                osd.hide(internetConnStateOsdID)
                unlockLibraryControls()
            } else {
                osd.show(lang.NO_SERVER_CONNECTION, 'fas fa-exclamation-triangle', internetConnStateOsdID, 'persistent', '#5a0619')
                lockLibraryControls()
            }
        } else {
            osd.show(lang.NO_INTERNET_CONNECTION, 'fas fa-exclamation-triangle', internetConnStateOsdID, 'persistent', '#5a0619')
            lockLibraryControls()
        }
        updateLibraryConnStatus()
    }
    
    updateInternetConnState()
    
    if(popupMode){
        handleArgs(nw.App.argv, () => {
            setTimeout(() => process.exit(0), 3000) // 100ms was too low and caused wmp to open but not play sometimes #wtf, keep it high to ensure.
        })
    } else {
        let usbDriveLetter = scanner.db.getDriveLetter(process.execPath)
        for(let dir of scanner.config.get('libraries')){
            let ret = await scanner.db.checkDriveChangeFile(dir, usbDriveLetter)
            if(ret){
                dir = ret.to + dir.substr(1)
            }
            addLibraryFolder(dir)
        }
        
        jQuery(window).on('online', updateInternetConnState).on('offline', updateInternetConnState)
        nw.App.on('open', args => {
            let processed, popupLoaded, cb = () => {
                if(processed && popupLoaded){
                    console.log('reached callback')
                    hidePopupLoader()
                }
            }
            showPopupLoader(() => {                
                popupLoaded = true
                cb()
            })
            handleArgs(args, () => {
                processed = true
                cb()
            })
        })

        setView(1)
        mapWizardStep(0) // slider must visible on creating
        setupOptions()
        setupLanguageSelector(availableLanguages, userLanguage)
        setupPlaylistFmtSelector(scanner.getPlaylistFormats(), scanner.config.get('playlist-format'))
        updateSimilarityOptions()
        renderLibrary()
        setView(0)
        density(parseFloat(scanner.config.get('density')) || 0.9)
        jQuery('body').removeClass('splash')
        console.log('libraries size', Object.keys(scanner.db.data).length)
        if(Object.keys(scanner.db.data).length){
            scanLibraries(true).catch(alert)
            jQuery('.main-container-filter input[type="text"]').trigger('focus')
        } else {
            enterLibrarySetup()
        }
        jQuery('[data-language]').each((i, e) => {
            const key = e.getAttribute('data-language'), tag = e.tagName.toLowerCase()
            const text = lang[key].replace(new RegExp('\r?\n', 'g'), '<br />')
            const plainText = lang[key].replace(new RegExp('[\r\n]+', 'g'), ' ')
            if(tag == 'input' && e.type == 'text') {
                e.placeholder = plainText
            } else {
                if(!e.innerHTML){
                    e.innerHTML = text
                }
            }
            e.title = plainText
        })
        jQuery(document).on('click', 'a[target="_system"]', e => {
            console.log(e)
            scanner.open(e.target.href)
            e.stopPropagation()
            e.preventDefault()
        })   

        let n = scanner.config.get('list-generated-learned')
        if(n && n >= 2){
            listGeneratedInfoLearned = true
        }
    }

    appLoaded = appLoaded.map(f => f()).length;  
})
