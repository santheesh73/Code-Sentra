# In-memory notes, persisted to a file path.
class Store
  def initialize(path)
    @path = path
    @notes = []
  end

  def add(title, body)
    note = { "id" => @notes.size + 1, "title" => title, "body" => body }
    @notes << note
    note
  end

  def all
    @notes
  end

  def find(id)
    @notes.find { |n| n["id"] == id }
  end

  def search(query)
    # TODO: search note bodies too
    @notes.select { |n| n["title"].include?(query) }
  end
end
