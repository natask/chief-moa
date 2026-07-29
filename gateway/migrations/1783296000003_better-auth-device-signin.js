exports.up = (pgm) => {
  pgm.sql(`
    create table if not exists auth_user (
      id text primary key,
      name text not null,
      email text not null unique,
      "emailVerified" boolean not null default false,
      image text,
      "createdAt" timestamptz not null,
      "updatedAt" timestamptz not null
    );

    create table if not exists auth_session (
      id text primary key,
      "expiresAt" timestamptz not null,
      token text not null unique,
      "createdAt" timestamptz not null,
      "updatedAt" timestamptz not null,
      "ipAddress" text,
      "userAgent" text,
      "userId" text not null references auth_user(id) on delete cascade
    );
    create index if not exists auth_session_user_id_idx on auth_session("userId");

    create table if not exists auth_account (
      id text primary key,
      "accountId" text not null,
      "providerId" text not null,
      "userId" text not null references auth_user(id) on delete cascade,
      "accessToken" text,
      "refreshToken" text,
      "idToken" text,
      "accessTokenExpiresAt" timestamptz,
      "refreshTokenExpiresAt" timestamptz,
      scope text,
      password text,
      "createdAt" timestamptz not null,
      "updatedAt" timestamptz not null
    );
    create index if not exists auth_account_user_id_idx on auth_account("userId");

    create table if not exists auth_verification (
      id text primary key,
      identifier text not null,
      value text not null,
      "expiresAt" timestamptz not null,
      "createdAt" timestamptz not null,
      "updatedAt" timestamptz not null
    );
    create index if not exists auth_verification_identifier_idx on auth_verification(identifier);

    create table if not exists auth_device_code (
      id text primary key,
      "deviceCode" text not null,
      "userCode" text not null,
      "userId" text,
      "expiresAt" timestamptz not null,
      status text not null,
      "lastPolledAt" timestamptz,
      "pollingInterval" integer,
      "clientId" text,
      scope text
    );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    drop table if exists auth_device_code;
    drop table if exists auth_verification;
    drop table if exists auth_account;
    drop table if exists auth_session;
    drop table if exists auth_user;
  `);
};
