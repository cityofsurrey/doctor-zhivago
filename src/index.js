import { OK, SERVICE_UNAVAILABLE } from 'http-status'
import fetch from 'node-fetch'
import tcpp from 'tcp-ping'
import redis from 'redis'
import qs from 'querystring'
import join from 'url-join'
import { introspectSchema } from 'graphql-tools'
import { HttpLink } from 'apollo-link-http'

function probe(hostname, port) {
  return new Promise((resolve, reject) => {
    tcpp.probe(hostname, port, (err, available) => {
      if (err) {
        reject(err)
        return
      }
      resolve(available)
    })
  })
}

export const apiCheck = async (url) => {
  try {
    const response = await fetch(url)

    return response.ok
  } catch (err) {
    return false
  }
}

export const mongoCheck = async mongoose => mongoose.connection.readyState === 1

export const oracleCheck = async (oracledb) => {
  try {
    const pong = await oracledb.ping()

    return pong
  } catch (err) {
    return false
  }
}

export const exchangeCheck = async (hostname) => {
  try {
    const available = await probe(hostname, 25)

    return available
  } catch (err) {
    return false
  }
}

export const redisCheck = async (hostname) => {
  try {
    const client = redis.createClient(6379, hostname)
    client.on('error', (err) => {
      client.quit()
      throw err
    })

    return true
  } catch (err) {
    return false
  }
}

export const cityworksCheck = async (url, token) => {
  try {
    const response = await fetch(`${url}/services/authentication/validate?data={"Token": ${qs.stringify(token)}}`, {
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) return false

    return true
  } catch (err) {
    return false
  }
}

export const mftCheck = sftp => (
  new Promise((resolve) => {
    if (sftp.client) {
      sftp.client.readdir('/', (err) => {
        if (err) {
          resolve(false)
        } else {
          resolve(true)
        }
      })
    } else {
      resolve(false)
    }
  })
)

export const graphqlCheck = async (url, endpoints) => {
  try {
    const response = await apiCheck(url)
    if (!response) return false

    const promises = endpoints.map(async (endpoint) => {
      const link = new HttpLink({ uri: join(url, endpoint), fetch })
      const schema = await introspectSchema(link)
      return schema
    })

    await Promise.all(promises)

    return true
  } catch (err) {
    return false
  }
}

export default params => async (req, res) => {
  const dependencies = Object.entries(params).filter(x => x[1].type)
  const statics = Object.entries(params).filter(x => !x[1].type)

  const promises = dependencies.map(([property, value]) => {
    switch (value.type) {
      case 'mongo': return mongoCheck(value.instance)
      case 'oracle': return oracleCheck(value.instance)
      case 'api': return apiCheck(value.url)
      case 'exchange': return exchangeCheck(value.hostname)
      case 'redis': return redisCheck(value.hostname)
      case 'cityworks': return cityworksCheck(value.url, value.token)
      case 'mft': return mftCheck(value.client)
      case 'graphql': return graphqlCheck(value.url, value.endpoints)

      default: return Promise.reject()
    }
  })

  const statuses = await Promise.all(promises)

  const dependenciesObject = dependencies
    .reduce((acc, x, i) => ({ ...acc, [x[0]]: statuses[i] }), {})
  const staticsObject = statics
    .reduce((acc, x) => ({ ...acc, [x[0]]: x[1] }), {})
  const health = { ...dependenciesObject, ...staticsObject }
  const status = statuses.every(x => x) ? OK : SERVICE_UNAVAILABLE

  res.status(status).json(health)
}
