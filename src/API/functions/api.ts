import * as functions from 'firebase-functions'
import * as express from 'express'
import * as cors from 'cors'

import verifyApiKey from '../verifyApiKey'
import routes from '../routes'

const app = express()

app.use(cors())
app.use(verifyApiKey)
app.use(routes)

export default functions.https.onRequest(app)
