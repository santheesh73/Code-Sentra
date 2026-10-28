require "sinatra/base"
require "json"
require_relative "lib/store"
require_relative "lib/export"
require_relative "lib/config"

# The notes HTTP API.
class NotesApp < Sinatra::Base
  STORE = Store.new(Config.db_path)

  get "/notes" do
    content_type :json
    STORE.all.to_json
  end

  post "/notes" do
    halt 403 unless request.env["HTTP_X_SIGNATURE"] == Config.signing_key
    note = STORE.add(params["title"], params["body"])
    content_type :json
    note.to_json
  end

  get "/notes/search" do
    content_type :json
    STORE.search(params["q"].to_s).to_json
  end

  get "/notes/:id/export.md" do
    content_type "text/markdown"
    Export.markdown(STORE.find(params["id"].to_i))
  end
end
