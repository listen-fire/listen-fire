#!/bin/bash
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
	CREATE USER test WITH PASSWORD 'test';
	CREATE DATABASE test;
  	GRANT ALL PRIVILEGES ON DATABASE test TO test;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname test <<-EOSQL
  	GRANT ALL ON SCHEMA public TO test;
EOSQL

psql -v ON_ERROR_STOP=1 --username test --dbname test <<-EOSQL
	create extension if not exists pgcrypto;
	create extension if not exists citext;
	select * FROM pg_extension;
EOSQL

