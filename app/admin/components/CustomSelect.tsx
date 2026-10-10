import { useState, useRef, useEffect } from "react";
import { ChevronDown } from "lucide-react";
import styles from "./CustomSelect.module.css";
import { roomAround } from "./menu-room";

interface CustomSelectProps {
  options: string[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

/** The menu's height (max 240px) and its 8px gap, plus a margin. */
const MENU_ROOM = 256;

export function CustomSelect({ options, value, onChange, placeholder = "Select an option" }: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [dropUp, setDropUp] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const toggle = () => {
    if (!isOpen && dropdownRef.current) {
      // Open upward when the menu would not fit below (dispatch 29).
      const { below, above } = roomAround(dropdownRef.current);
      setDropUp(below < MENU_ROOM && above > below);
    }
    setIsOpen(!isOpen);
  };

  return (
    <div className={styles.container} ref={dropdownRef}>
      <button
        type="button"
        className={`${styles.selectButton} ${isOpen ? styles.active : ''}`}
        onClick={toggle}
      >
        <span className={value ? styles.valueText : styles.placeholderText}>
          {value || placeholder}
        </span>
        <ChevronDown size={16} className={isOpen ? styles.chevronOpen : ''} />
      </button>

      {isOpen && (
        <div className={`${styles.dropdownMenu} ${dropUp ? styles.dropdownMenuUp : ''}`}>
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className={`${styles.dropdownOption} ${value === option ? styles.selectedOption : ''}`}
              onClick={() => {
                onChange(option);
                setIsOpen(false);
              }}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
