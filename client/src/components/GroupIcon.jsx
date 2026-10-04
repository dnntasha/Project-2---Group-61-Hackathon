//Handles group icon, or first letter when no icon has been unloaded
export default function GroupIcon({ group, size = 40 }) {
  const style = { width: size, height: size, fontSize: size * 0.45 };

  if (group.iconUrl) {
    return (
      <imp className="group-icon" src={group.iconUrl} alt="" style={style} />
    );
  }
  return (
    <span
      className="grop-icon group-icon-letter"
      style={style}
      aria-hidden="true"
    >
      {group.name.charAt(0).toUpperCase()}
    </span>
  );
}
