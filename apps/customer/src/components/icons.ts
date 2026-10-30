import { colourIcons } from "@ygo/mobile";
import {
  Bell, Briefcase, ChevronDown, ChevronLeft, CircleArrowRight, CircleCheck, CircleX, Clock, House, LogOut, Mail, Map, MapPin, Minus, Phone, Plus, Search, Trash2, User,
} from "lucide-react-native";
import Svg from "react-native-svg";

colourIcons(Bell, Briefcase, ChevronDown, ChevronLeft, CircleArrowRight, CircleCheck, CircleX, Clock, House, LogOut, Mail, Map, MapPin, Minus, Phone, Plus, Search, Trash2, User);
// The Order placed check mark draws in `currentColor` from a text class (#427).
colourIcons(Svg);

export {
  Bell, Briefcase, ChevronDown, ChevronLeft, CircleArrowRight, CircleCheck, CircleX, Clock, House, LogOut, Mail, Map, MapPin, Minus, Phone, Plus, Search, Trash2, User,
};
