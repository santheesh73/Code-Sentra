# Settings from the environment.
module Config
  def self.db_path
    ENV.fetch("NOTES_DB_PATH", "notes.json")
  end

  def self.signing_key
    ENV["NOTES_SIGNING_KEY"]
  end
end
