import type { RequestHandler } from 'express';

/** Unknown API paths must never fall through to the SPA's index.html with HTTP 200. */
export const apiNotFound: RequestHandler = (req, res) => {
  res.status(404).json({
    error: {
      code: 'API_NOT_FOUND',
      message: `Unknown API route: ${req.method} ${req.path}`,
      timestamp: Date.now(),
    },
  });
};
