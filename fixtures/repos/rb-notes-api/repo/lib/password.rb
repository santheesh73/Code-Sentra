require "bcrypt"

# Password hashes for note owners.
module Password
  def self.digest(secret)
    BCrypt::Password.create(secret)
  end
end
