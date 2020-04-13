const {
  BaseKonnector,
  requestFactory,
  signin,
  saveFiles,
  log
} = require('cozy-konnector-libs')

const request = requestFactory({
  // The debug mode shows all the details about HTTP requests and responses. Very useful for
  // debugging but very verbose. This is why it is commented out by default
  // debug: true,
  // Activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: false,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: true,
  // This allows request-promise to keep cookies between requests
  jar: true
})

module.exports = new BaseKonnector(start)

const defaultOptions = {
  files: true,
  photos: true
}

const parseKonnOptions = () => {
  try {
    const envVar = process.env.KONN_OPTIONS
    return Object.assign(
      {},
      ...envVar.split(',').map(token => {
        const active = token[0] !== '-'
        return { [token.slice(1)]: active }
      })
    )
  } catch (e) {
    throw e
    return defaultOptions
  }
}

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
// cozyParameters are static parameters, independents from the account. Most often, it can be a
// secret api key.
async function start(fields, cozyParameters) {
  log('info', 'Authenticating ...')
  if (cozyParameters) log('debug', 'Found COZY_PARAMETERS')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  const pads = await fetchPads()

  const options = parseKonnOptions()
  if (options.files !== false) {
    const gazetteFileEntries = await fetchGazettes(pads)
    await saveFiles(gazetteFileEntries, fields, {
      fileIdAttributes: ['fileurl'],
      concurrency: 8
    })
  }

  if (options.photos !== false) {
    const photosFileEntries = await fetchPhotos(pads)
    await saveFiles(photosFileEntries, fields, {
      fileIdAttributes: ['fileurl'],
      concurrency: 8,
      contentType: 'image/jpeg' // need this to force the stack to take our date into account
    })
  }
}

function authenticate(username, password) {
  return signin({
    url: `https://www.famileo.com/login`,
    formSelector: 'form',
    formData: {
      _username: username,
      _password: password
    },
    validate: (statusCode, $) => {
      // The login in toscrape.com always works except when no password is set
      if ($(`a[href='/logout']`).length === 1) {
        return true
      } else {
        log('error', $('.alert').text())
        return false
      }
    }
  })
}

const flatten = arrays => [].concat(...arrays)

const fetchPads = async () => {
  const { pads } = await request.get('https://www.famileo.com/api/user/pad')
  log('info', `Found ${pads.length} pads`)
  log('debug', pads.map(pad => `- ${pad.pad_name} (${pad.pad_id})`).join('\n'))
  return pads
}

const gazetteToFileEntry = gazette => ({
  fileurl: gazette.pdf,
  subPath: `${gazette.pad.pad_name}`,
  filename: `${gazette.created_at.slice(0, 10)}.pdf`
})

const fetchPadGazettes = async pad => {
  const { gazettes } = await request.get(
    `https://www.famileo.com/api/gazettes/${pad.pad_id}`
  )
  return gazettes.map(gazette => ({ ...gazette, pad: pad }))
}

const fetchGazettes = async pads => {
  const padsGazettes = await Promise.all(pads.map(fetchPadGazettes))

  return flatten(
    padsGazettes.map(padGazettes => padGazettes.map(gazetteToFileEntry))
  )
}

const formatPhotoFilename = photo => {
  const dateTime = photo.created_at.slice(0, 16)
  const author = `${photo.firstname} ${photo.lastname}`
  return `${dateTime} ${author}.jpg`
}

const photoToFileEntry = photo => ({
  fileurl: photo.image,
  subPath: `${photo.pad.pad_name}/Photos`,
  filename: formatPhotoFilename(photo),
  fileAttributes: {
    lastModifiedDate: new Date(photo.created_at)
  }
})

const fetchPadPhotos = async pad => {
  let timestamp = false
  let finished = false
  let allPhotos = []
  let i = 0
  while (!finished && i < 1000) {
    i++
    const { gallery: photos, nb_all_image } = await request.get(
      `https://www.famileo.com/api/galleries/${pad.pad_id}?${
        timestamp ? `timestamp=${timestamp}&` : ''
      }&type=all`
    )
    if (photos.length == 0) {
      finished = true
      continue
    }

    allPhotos = allPhotos.concat(photos.map(photo => ({ ...photo, pad })))
    timestamp = photos[photos.length - 1].created_at
    log('debug', 'Setting pagination timestamp to', timestamp)
    log('debug', `Retrieved ${allPhotos.length} / ${nb_all_image}`)
    if (allPhotos.length >= nb_all_image) {
      finished = true
    }
    photos.forEach(photo => {
      log(
        'debug',
        `Retrieved photo by ${photo.firstname} ${photo.lastname} on ${photo.created_at}`
      )
    })
  }

  return allPhotos
}

const fetchPhotos = async pads => {
  const padsPhotos = await Promise.all(pads.map(fetchPadPhotos))
  return flatten(padsPhotos.map(padPhotos => padPhotos.map(photoToFileEntry)))
}
