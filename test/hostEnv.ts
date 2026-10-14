process.env.TZ = 'UTC'
process.env.LANG = 'en_US.UTF-8'
process.env.LC_ALL = 'en_US.UTF-8'
for (const name of ['ZDOTDIR', 'ENV', 'BASH_ENV', 'LANGUAGE', 'LC_TIME', 'LC_NUMERIC']) {
  delete process.env[name]
}
