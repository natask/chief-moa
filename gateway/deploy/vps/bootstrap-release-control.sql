\set ON_ERROR_STOP on

select 'create database moa_release_control owner moa'
 where not exists (
   select 1 from pg_database where datname = 'moa_release_control'
 )
\gexec

select format('create role moa_release_app login password %L', :'app_password')
 where not exists (
   select 1 from pg_roles where rolname = 'moa_release_app'
 )
\gexec

select format('alter role moa_release_app login password %L', :'app_password')
\gexec

select format('create role moa_release_publisher login password %L', :'publisher_password')
 where not exists (
   select 1 from pg_roles where rolname = 'moa_release_publisher'
 )
\gexec

select format('alter role moa_release_publisher login password %L', :'publisher_password')
\gexec
