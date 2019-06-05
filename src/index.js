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
  // convert params object to an array of object for convenience
  const dependencies = Object
    .entries(params)
    .map(([property, value]) => (typeof value === 'object'
      ? ({ name: property, ...value })
      : ({ name: property, value })
    ))
  const dynamics = dependencies.filter(x => x.type)
  const statics = dependencies.filter(x => !x.type)

  const statuses = await Promise.all(dynamics.map((x) => {
    switch (x.type) {
      case 'mongo': return mongoCheck(x.instance)
      case 'oracle': return oracleCheck(x.instance)
      case 'api': return apiCheck(x.url)
      case 'exchange': return exchangeCheck(x.hostname)
      case 'redis': return redisCheck(x.hostname)
      case 'cityworks': return cityworksCheck(x.url, x.token)
      case 'mft': return mftCheck(x.client)
      case 'graphql': return graphqlCheck(x.url, x.endpoints)

      default: return Promise.reject()
    }
  }))

  // dependencies are dynamics with statuses
  const dependenciesWithStatus = dynamics.map((x, i) => ({ ...x, status: statuses[i] }))
  const staticsObject = statics.reduce((acc, x) => ({ ...acc, [x.name]: x.value }), {})
  const requiredDependenciesObject = dependenciesWithStatus.reduce((acc, x) => (
    x.optional ? acc : { ...acc, [x.name]: x.status }
  ), {})
  const optionalDependenciesObject = dependenciesWithStatus.reduce((acc, x) => (
    x.optional ? { ...acc, [x.name]: x.status } : acc
  ), {})

  let health = { ...staticsObject, ...requiredDependenciesObject }
  if (dependenciesWithStatus.some(x => x.optional)) {
    health = { ...health, optional: optionalDependenciesObject }
  }
  const status = dependenciesWithStatus.filter(x => !x.optional).every(x => x.status)
    ? OK
    : SERVICE_UNAVAILABLE

  res.status(status).json(health)
}
