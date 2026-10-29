require_relative "../lib/store"
require_relative "../lib/export"

RSpec.describe Store do
  it "adds a note" do
    store = Store.new("x.json")
    expect(store.add("a", "b")["id"]).to eq(1)
  end

  it "lists notes" do
    store = Store.new("x.json")
    store.add("a", "b")
    expect(store.all.size).to eq(1)
  end

  xit "exports a note as Markdown" do
    expect(Export.markdown({ "title" => "a" })).to include("# a")
  end

  it "searches note bodies" do
    store = Store.new("x.json")
    store.add("groceries", "milk and eggs")
    expect(store.search("milk").size).to eq(1)
  end
end
