import type { Request, Response, NextFunction } from 'express';
import { jwtVerify, createRemoteJWKSet, type JWTVerifyGetKey } from 'jose';

export type AccessConfig = { issuer: string; audience: string; keys: JWTVerifyGetKey };

/** Returns null when ACCESS_TEAM_DOMAIN and ACCESS_AUD are both unset (Access not enforced). */
export const accessConfigFromEnv = (env: NodeJS.ProcessEnv): AccessConfig | null => {
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.ACCESS_AUD?.trim();
  if (!team && !audience) return null;
  if (!team || !audience) throw new Error('ACCESS_TEAM_DOMAIN and ACCESS_AUD must be set together');
  const issuer = `https://${team}`;
  return { issuer, audience, keys: createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)) };
};

/** Verifies the Cf-Access-Jwt-Assertion header Cloudflare Access attaches to every forwarded request. */
export const requireAccess = (cfg: AccessConfig) => async (req: Request, res: Response, next: NextFunction) => {
  const token = req.header('cf-access-jwt-assertion');
  if (!token) return res.status(401).json({ error: 'access_required' });
  try {
    const { payload } = await jwtVerify(token, cfg.keys, { issuer: cfg.issuer, audience: cfg.audience });
    res.locals.actor = typeof payload.email === 'string' ? payload.email : undefined;
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_access_token' });
  }
};
