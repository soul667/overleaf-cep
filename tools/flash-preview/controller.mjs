import http from 'node:http'

export function preview(req, res, next) {
  const body = JSON.stringify(req.body)
  const request = http.request({
    socketPath: '/run/flash-preview/worker.sock',
    path: '/flash-preview/' + req.params.Project_id,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Cookie: req.headers.cookie || '',
      Origin: req.headers.origin || '',
    },
    timeout: 120000,
  }, response => {
    res.status(response.statusCode).set('Cache-Control', 'no-store')
    res.type(response.headers['content-type'] || 'text/plain')
    response.on('error', next)
    response.pipe(res)
  })
  request.on('timeout', () => request.destroy(new Error('Preview timed out')))
  request.on('error', next)
  request.end(body)
}
